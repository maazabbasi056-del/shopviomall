const mongoose = require("mongoose");
const SellerWallet = require("../models/SellerWallet");
const SellerLedgerEntry = require("../models/SellerLedgerEntry");
const SellerMoneyRequest = require("../models/SellerMoneyRequest");

const cents = (value, currency = "USD") => {
  const precision = String(currency).toUpperCase() === "USD" ? 2 : 8;
  const factor = 10 ** precision;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

async function legacyWalletSeed(sellerId, currency, session) {
  const entries = await SellerLedgerEntry.find({ sellerId, currency }).session(session).lean();
  let availableBalance = 0, heldBalance = 0, lifetimeRevenue = 0, totalDeposits = 0, totalWithdrawals = 0;
  for (const entry of entries) {
    if (typeof entry.availableDelta === "number" || typeof entry.heldDelta === "number") {
      availableBalance += Number(entry.availableDelta || 0);
      heldBalance += Number(entry.heldDelta || 0);
      if (entry.type === "order_hold" || entry.type === "sale") lifetimeRevenue += Number(entry.amount || 0);
      if (entry.type === "deposit" && entry.status === "completed") totalDeposits += Number(entry.amount || 0);
      if (entry.type === "withdrawal" && entry.status === "completed") totalWithdrawals += Number(entry.amount || 0);
    } else if (entry.status === "completed") {
      const amount = Number(entry.amount || 0);
      if (["sale", "deposit", "refund"].includes(entry.type)) availableBalance += amount;
      else if (["withdrawal", "adjustment"].includes(entry.type)) availableBalance -= amount;
      if (entry.type === "sale") lifetimeRevenue += amount;
      if (entry.type === "deposit") totalDeposits += amount;
      if (entry.type === "withdrawal") totalWithdrawals += amount;
    }
  }
  const oldRequests = await SellerMoneyRequest.find({ sellerId, currency, kind: "withdrawal", status: "pending_review" }).session(session).lean();
  for (const request of oldRequests) {
    const amount = cents(request.amount, currency);
    availableBalance -= amount; heldBalance += amount;
    await SellerLedgerEntry.updateOne({ idempotencyKey: `legacy-withdrawal:${request._id}` }, { $setOnInsert: {
      sellerId, type: "withdrawal", amount, availableDelta: -amount, heldDelta: amount,
      currency, status: "pending", relatedRequestId: request._id, idempotencyKey: `legacy-withdrawal:${request._id}`,
      description: "Stage 5 withdrawal request reserved during wallet migration."
    } }, { upsert: true, session, runValidators: true });
  }
  return { availableBalance: cents(Math.max(0, availableBalance), currency), heldBalance: cents(Math.max(0, heldBalance), currency), lifetimeRevenue: cents(Math.max(0, lifetimeRevenue), currency), totalDeposits: cents(Math.max(0, totalDeposits), currency), totalWithdrawals: cents(Math.max(0, totalWithdrawals), currency) };
}

async function getOrCreateWallet(sellerId, currency, session) {
  let wallet = await SellerWallet.findOne({ sellerId, currency }).session(session);
  if (wallet) return wallet;
  const seed = await legacyWalletSeed(sellerId, currency, session);
  try {
    [wallet] = await SellerWallet.create([{ sellerId, currency, ...seed }], { session });
    return wallet;
  } catch (error) {
    if (error.code !== 11000) throw error;
    wallet = await SellerWallet.findOne({ sellerId, currency }).session(session);
    if (!wallet) throw error;
    return wallet;
  }
}

async function withWalletTransaction(work) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally { await session.endSession(); }
}

async function applyLedgerMovement({ sellerId, currency = "USD", type, amount, availableDelta = 0, heldDelta = 0, status = "completed", description = "", reason = "", adminId = null, relatedRequestId = null, relatedOrderId = null, idempotencyKey, session }) {
  amount = cents(amount, currency); availableDelta = cents(availableDelta, currency); heldDelta = cents(heldDelta, currency);
  const wallet = await getOrCreateWallet(sellerId, currency, session);
  const nextAvailable = cents(wallet.availableBalance + availableDelta, currency);
  const nextHeld = cents(wallet.heldBalance + heldDelta, currency);
  if (nextAvailable < 0 || nextHeld < 0) {
    const error = new Error("Insufficient available or held balance."); error.status = 409; throw error;
  }
  if (idempotencyKey) {
    const existing = await SellerLedgerEntry.findOne({ idempotencyKey }).session(session);
    if (existing) { const error = new Error("This wallet movement has already been recorded."); error.status = 409; throw error; }
  }
  const changes = {
    availableBalance: availableDelta,
    heldBalance: heldDelta,
    version: 1
  };
  if (type === "sale" || type === "order_hold") changes.lifetimeRevenue = amount;
  if (type === "deposit") changes.totalDeposits = amount;
  if (type === "withdrawal" && status === "completed" && heldDelta < 0) changes.totalWithdrawals = amount;
  wallet.availableBalance = nextAvailable;
  wallet.heldBalance = nextHeld;
  if (changes.lifetimeRevenue) wallet.lifetimeRevenue = cents(wallet.lifetimeRevenue + changes.lifetimeRevenue, currency);
  if (changes.totalDeposits) wallet.totalDeposits = cents(wallet.totalDeposits + changes.totalDeposits, currency);
  if (changes.totalWithdrawals) wallet.totalWithdrawals = cents(wallet.totalWithdrawals + changes.totalWithdrawals, currency);
  wallet.version += 1;
  await wallet.save({ session });
  const [entry] = await SellerLedgerEntry.create([{
    sellerId, currency, type, amount, availableDelta, heldDelta, status, description, reason,
    adminId, relatedRequestId, relatedOrderId, idempotencyKey
  }], { session });
  return { wallet, entry };
}

async function readWalletSummaries(sellerId, currencyFilter) {
  const filter = { sellerId };
  if (currencyFilter) filter.currency = currencyFilter.toUpperCase();
  const [entries, wallets, legacyRequests] = await Promise.all([
    SellerLedgerEntry.find(filter).lean(),
    SellerWallet.find(filter).lean(),
    SellerMoneyRequest.find({ sellerId, kind: "withdrawal", status: "pending_review", ...(currencyFilter ? { currency: currencyFilter.toUpperCase() } : {}) }).lean()
  ]);
  const currencySet = new Set([...entries.map((entry) => entry.currency || "USD"), ...wallets.map((wallet) => wallet.currency), ...legacyRequests.map((request) => request.currency || "USD")]);
  if (!currencySet.size) currencySet.add(currencyFilter?.toUpperCase() || "USD");
  return [...currencySet].map((currency) => {
    const wallet = wallets.find((item) => item.currency === currency);
    if (wallet) return { currency, availableBalance: cents(wallet.availableBalance, currency), heldBalance: cents(wallet.heldBalance, currency), lifetimeRevenue: cents(wallet.lifetimeRevenue, currency), deposits: cents(wallet.totalDeposits, currency), withdrawals: cents(wallet.totalWithdrawals, currency) };
    const list = entries.filter((entry) => (entry.currency || "USD") === currency);
    let availableBalance = 0, heldBalance = 0, lifetimeRevenue = 0, deposits = 0, withdrawals = 0;
    for (const entry of list) {
      if (Number.isFinite(entry.availableDelta) || Number.isFinite(entry.heldDelta)) { availableBalance += Number(entry.availableDelta || 0); heldBalance += Number(entry.heldDelta || 0); }
      else if (entry.status === "completed") {
        const amount = Number(entry.amount || 0);
        if (["sale", "deposit", "refund"].includes(entry.type)) availableBalance += amount;
        else if (["withdrawal", "adjustment"].includes(entry.type)) availableBalance -= amount;
      }
      if (["sale", "order_hold"].includes(entry.type)) lifetimeRevenue += Number(entry.amount || 0);
      if (entry.type === "deposit" && entry.status === "completed") deposits += Number(entry.amount || 0);
      if (entry.type === "withdrawal" && entry.status === "completed") withdrawals += Number(entry.amount || 0);
    }
    for (const request of legacyRequests.filter((item) => item.currency === currency)) { availableBalance -= request.amount; heldBalance += request.amount; }
    return { currency, availableBalance: cents(Math.max(0, availableBalance), currency), heldBalance: cents(Math.max(0, heldBalance), currency), lifetimeRevenue: cents(Math.max(0, lifetimeRevenue), currency), deposits: cents(deposits, currency), withdrawals: cents(withdrawals, currency) };
  });
}

module.exports = { cents, getOrCreateWallet, withWalletTransaction, applyLedgerMovement, readWalletSummaries };
