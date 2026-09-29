const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const Product = require("../models/Product");
const SellerKycDocument = require("../models/SellerKycDocument");
const SellerApplication = require("../models/SellerApplication");
const SellerLedgerEntry = require("../models/SellerLedgerEntry");
const SellerMoneyRequest = require("../models/SellerMoneyRequest");
const AdminAuditLog = require("../models/AdminAuditLog");
const AdminNotification = require("../models/AdminNotification");
const OrderNotification = require("../models/OrderNotification");
const ChatConversation = require("../models/ChatConversation");
const Order = require("../models/Order");
const PaymentMethod = require("../models/PaymentMethod");
const { notifySeller } = require("../services/sellerNotifications");
const MarketplaceCategory = require("../models/MarketplaceCategory");
const { listCategories, slugify } = require("../services/categoryCatalog");
const { requireAuth, requireDatabase, requireRole } = require("../middleware/auth");
const { recordAdminAction } = require("../services/adminAudit");
const { notifyAdmins } = require("../services/adminNotifications");
const { cents, withWalletTransaction, applyLedgerMovement, readWalletSummaries } = require("../services/walletLedger");
const { createOrderFromLines, saveOrderNotification, appendStatusEvent } = require("../services/orders");
const { releaseFulfillmentEarning, notifyFulfillment, addMasterStatus, validateHttpsUrl, inTransaction, ORDER_NUMBER, NEXT_STATUS } = require("./orders");

const router = express.Router();
router.use(requireDatabase, requireAuth, requireRole("admin"));
const idOK = mongoose.isValidObjectId;
const safePattern = (value) => String(value || "").slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pageOptions = (query) => ({ page: Math.max(1, Math.min(Number.parseInt(query.page, 10) || 1, 10000)), limit: Math.max(1, Math.min(Number.parseInt(query.limit, 10) || 25, 100)) });
const publicUserFields = "name email role accountStatus customerStatus emailVerified kycStatus shopName shopSlug shopBio shopImageUrl createdAt updatedAt";

async function writeAudit(req, action, targetType, targetId, reason = "", details = {}, session) {
  return recordAdminAction({ adminId: req.user._id, action, targetType, targetId, reason, details, session });
}

async function walletSummary(sellerId, currency) {
  return readWalletSummaries(sellerId, currency);
}

router.get("/payment-methods", async (_req, res, next) => {
  try { const methods = await PaymentMethod.find().sort({ asset: 1, network: 1 }).lean(); res.json({ success: true, methods }); }
  catch (error) { next(error); }
});
router.post("/payment-methods", async (req, res, next) => {
  const method = normalizePaymentMethod(req.body);
  if (method.error) return res.status(400).json({ success: false, message: method.error });
  try {
    const saved = await PaymentMethod.create(method.fields);
    await writeAudit(req, "payment_method_created", "payment_method", saved._id, "Payment method created.", { asset: saved.asset, network: saved.network, enabled: saved.enabled });
    res.status(201).json({ success: true, method: saved });
  } catch (error) { if (error.code === 11000) return res.status(409).json({ success: false, message: "That asset and network already exist." }); next(error); }
});
router.patch("/payment-methods/:methodId", async (req, res, next) => {
  if (!idOK(req.params.methodId)) return res.status(400).json({ success: false, message: "Invalid payment method ID." });
  const normalized = normalizePaymentMethod(req.body, true);
  if (normalized.error) return res.status(400).json({ success: false, message: normalized.error });
  try {
    const method = await PaymentMethod.findByIdAndUpdate(req.params.methodId, { $set: normalized.fields }, { new: true, runValidators: true });
    if (!method) return res.status(404).json({ success: false, message: "Payment method not found." });
    await writeAudit(req, "payment_method_updated", "payment_method", method._id, "Payment settings updated.", { asset: method.asset, network: method.network, enabled: method.enabled });
    res.json({ success: true, method });
  } catch (error) { if (error.code === 11000) return res.status(409).json({ success: false, message: "That asset and network already exist." }); next(error); }
});

function normalizePaymentMethod(body = {}, partial = false) {
  const allowed = ["asset", "symbol", "network", "receivingAddress", "enabled", "instructions", "minimumDeposit"];
  if (!body || typeof body !== "object" || Object.keys(body).some((key) => !allowed.includes(key))) return { error: "Payment settings contain unsupported fields." };
  const fields = {};
  for (const key of ["asset", "symbol", "network", "receivingAddress", "instructions"]) if (body[key] !== undefined) {
    if (typeof body[key] !== "string") return { error: "Payment settings text fields are invalid." };
    fields[key] = body[key].trim();
  }
  if (body.enabled !== undefined) { if (typeof body.enabled !== "boolean") return { error: "Enabled must be true or false." }; fields.enabled = body.enabled; }
  if (body.minimumDeposit !== undefined) { const value = Number(body.minimumDeposit); if (!Number.isFinite(value) || value < 0 || value > 1e9) return { error: "Minimum deposit is invalid." }; fields.minimumDeposit = value; }
  if (!partial && ["asset", "symbol", "network", "receivingAddress"].some((key) => !fields[key])) return { error: "Asset, symbol, network, and public receiving address are required." };
  if (["asset", "symbol", "network", "receivingAddress"].some((key) => fields[key] !== undefined && !fields[key])) return { error: "Payment settings cannot contain empty required fields." };
  fields.asset = fields.asset?.toUpperCase(); fields.symbol = fields.symbol?.toUpperCase();
  if (fields.receivingAddress && fields.receivingAddress.length > 256) return { error: "Receiving address is too long." };
  return { fields };
}

router.get("/dashboard", async (_req, res, next) => {
  try {
    const [totalCustomers, totalSellers, pendingSellerApplications, activeProducts, pendingDeposits, pendingWithdrawals, orderCount, recentActivity] = await Promise.all([
      User.countDocuments({ role: "customer" }),
      User.countDocuments({ role: "vendor" }),
      SellerApplication.countDocuments({ status: { $in: ["pending", "under_review", "needs_information"] } }),
      Product.countDocuments({ status: "active" }),
      SellerMoneyRequest.countDocuments({ kind: "deposit", status: { $in: ["pending", "pending_review", "awaiting_payment", "payment_submitted", "under_review"] } }),
      SellerMoneyRequest.countDocuments({ kind: "withdrawal", status: { $in: ["pending", "pending_review", "under_review", "approved"] } }),
      Order.countDocuments(),
      AdminAuditLog.find().populate("adminId", "name email").sort({ createdAt: -1 }).limit(10).lean()
    ]);
    res.json({ success: true, counts: { totalCustomers, totalSellers, pendingSellerApplications, activeProducts, pendingDeposits, pendingWithdrawals, orders: orderCount }, recentActivity });
  } catch (error) { next(error); }
});

router.get("/sellers", async (req, res, next) => {
  try {
    const { page, limit } = pageOptions(req.query), filter = { role: "vendor" }, search = safePattern(req.query.q);
    if (search) filter.$or = [{ name: new RegExp(search, "i") }, { email: new RegExp(search, "i") }, { shopName: new RegExp(search, "i") }, { shopSlug: new RegExp(search, "i") }];
    if (["pending", "approved", "suspended"].includes(req.query.status)) filter.accountStatus = req.query.status;
    const [sellers, total] = await Promise.all([User.find(filter).select(publicUserFields).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), User.countDocuments(filter)]);
    const rows = await Promise.all(sellers.map(async (seller) => {
      const [productCount, balances] = await Promise.all([Product.countDocuments({ sellerId: seller._id }), walletSummary(seller._id)]);
      return { ...seller, productCount, wallet: balances };
    }));
    res.json({ success: true, sellers: rows, total, page, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
});

router.get("/sellers/:sellerId", async (req, res, next) => {
  if (!idOK(req.params.sellerId)) return res.status(400).json({ success: false, message: "Invalid seller ID." });
  try {
    const seller = await User.findOne({ _id: req.params.sellerId, role: "vendor" }).select(publicUserFields).lean();
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found." });
    const [productCount, wallet, application] = await Promise.all([
      Product.countDocuments({ sellerId: seller._id }), walletSummary(seller._id),
      SellerApplication.findOne({ sellerId: seller._id }).select("shopName shopSlug description documentType status submittedAt reviewedAt sellerMessage").lean()
    ]);
    res.json({ success: true, seller, productCount, wallet, application });
  } catch (error) { next(error); }
});

router.get("/sellers/:sellerId/listings", async (req, res, next) => {
  if (!idOK(req.params.sellerId)) return res.status(400).json({ success: false, message: "Invalid seller ID." });
  try { const products = await Product.find({ sellerId: req.params.sellerId }).sort({ createdAt: -1 }).lean(); res.json({ success: true, products }); }
  catch (error) { next(error); }
});

router.get("/sellers/:sellerId/storefront", async (req, res, next) => {
  if (!idOK(req.params.sellerId)) return res.status(400).json({ success: false, message: "Invalid seller ID." });
  try {
    const seller = await User.findOne({ _id: req.params.sellerId, role: "vendor" }).select("name shopName shopSlug shopBio shopImageUrl accountStatus kycStatus").lean();
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found." });
    const products = await Product.find({ sellerId: seller._id, status: "active" }).select("title category subcategory price images stock").sort({ createdAt: -1 }).lean();
    res.json({ success: true, storefront: seller, products });
  } catch (error) { next(error); }
});

router.patch("/sellers/:sellerId/status", async (req, res, next) => {
  if (!idOK(req.params.sellerId)) return res.status(400).json({ success: false, message: "Invalid seller ID." });
  const status = req.body?.status;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!["active", "suspended"].includes(status) || !reason || reason.length > 1000) return res.status(400).json({ success: false, message: "Choose active or suspended and provide a reason." });
  try {
    const seller = await User.findOne({ _id: req.params.sellerId, role: "vendor" });
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found." });
    if (status === "active" && seller.kycStatus !== "approved") return res.status(409).json({ success: false, message: "Approve seller verification before activating this account." });
    seller.accountStatus = status === "active" ? "approved" : "suspended";
    await seller.save();
    await writeAudit(req, status === "active" ? "seller_activated" : "seller_suspended", "seller", seller._id, reason, { accountStatus: seller.accountStatus });
    res.json({ success: true, seller: { id: String(seller._id), name: seller.name, email: seller.email, shopName: seller.shopName, accountStatus: seller.accountStatus, kycStatus: seller.kycStatus } });
  } catch (error) { next(error); }
});

router.get("/applications", async (req, res, next) => {
  try {
    const { page, limit } = pageOptions(req.query), filter = {};
    if (["pending", "under_review", "approved", "rejected", "needs_information"].includes(req.query.status)) filter.status = req.query.status;
    const search = safePattern(req.query.q);
    if (search) {
      const matchingSellers = await User.find({ role: "vendor", $or: [{ name: new RegExp(search, "i") }, { email: new RegExp(search, "i") }, { shopName: new RegExp(search, "i") }] }).select("_id").lean();
      const matchingIds = matchingSellers.map((seller) => seller._id);
      filter.$or = [{ shopName: new RegExp(search, "i") }, { shopSlug: new RegExp(search, "i") }, { sellerId: { $in: matchingIds } }];
    }
    const [applications, total] = await Promise.all([
      SellerApplication.find(filter).populate("sellerId", "name email shopName shopSlug accountStatus kycStatus createdAt").sort({ submittedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SellerApplication.countDocuments(filter)
    ]);
    const safe = applications.map(({ documentNumber, ...application }) => application);
    res.json({ success: true, applications: safe, total, page, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
});

router.get("/applications/:applicationId", async (req, res, next) => {
  if (!idOK(req.params.applicationId)) return res.status(400).json({ success: false, message: "Invalid application ID." });
  try {
    const application = await SellerApplication.findById(req.params.applicationId).select("+documentNumber").populate("sellerId", publicUserFields).lean();
    if (!application) return res.status(404).json({ success: false, message: "Seller application not found." });
    const documents = await SellerKycDocument.find({ sellerId: application.sellerId._id }).select("kind filename mimeType reviewStatus reviewNote reviewedAt createdAt").lean();
    res.json({ success: true, application, documents });
  } catch (error) { next(error); }
});

router.get("/applications/:applicationId/documents/:kind", async (req, res, next) => {
  if (!idOK(req.params.applicationId)) return res.status(400).json({ success: false, message: "Invalid application ID." });
  if (!["identity", "address", "id_front", "id_back", "selfie"].includes(req.params.kind)) return res.status(400).json({ success: false, message: "Invalid document type." });
  try {
    const application = await SellerApplication.findById(req.params.applicationId).select("sellerId").lean();
    if (!application) return res.status(404).json({ success: false, message: "Seller application not found." });
    const document = await SellerKycDocument.findOne({ sellerId: application.sellerId, kind: req.params.kind }).select("+data");
    if (!document) return res.status(404).json({ success: false, message: "Document not found." });
    res.set("Content-Type", document.mimeType).set("Content-Disposition", `inline; filename="${document.filename.replace(/["\r\n]/g, "_")}"`).set("Cache-Control", "no-store, private").send(document.data);
  } catch (error) { next(error); }
});

router.patch("/applications/:applicationId/review", async (req, res, next) => {
  if (!idOK(req.params.applicationId)) return res.status(400).json({ success: false, message: "Invalid application ID." });
  const { status, notes = "", sellerMessage = "" } = req.body || {};
  if (!["under_review", "approved", "rejected", "needs_information"].includes(status) || typeof notes !== "string" || notes.trim().length > 3000 || typeof sellerMessage !== "string" || sellerMessage.trim().length > 1000) return res.status(400).json({ success: false, message: "Review status or notes are invalid." });
  if (status === "needs_information" && !sellerMessage.trim()) return res.status(400).json({ success: false, message: "Explain what additional information the seller must provide." });
  try {
    const application = await SellerApplication.findById(req.params.applicationId).select("+documentNumber");
    if (!application) return res.status(404).json({ success: false, message: "Seller application not found." });
    if (application.status === "approved" || application.status === "rejected") return res.status(409).json({ success: false, message: "This application has already been finalized." });
    if (status === "approved") {
      if (!application.termsAcceptedAt) return res.status(409).json({ success: false, message: "Seller terms must be accepted before approval." });
      const required = ["id_front", "selfie", ...(application.documentType === "passport" ? [] : ["id_back"] )];
      const docs = await SellerKycDocument.find({ sellerId: application.sellerId, kind: { $in: required } }).select("kind").lean();
      if (!required.every((kind) => docs.some((doc) => doc.kind === kind))) return res.status(409).json({ success: false, message: "Required identity front/back and verification image documents are not all present." });
    }
    const previousStatus = application.status;
    application.status = status; application.reviewedAt = new Date(); application.reviewedBy = req.user._id;
    application.adminNotes = notes.trim(); application.sellerMessage = sellerMessage.trim(); await application.save();
    const seller = await User.findById(application.sellerId);
    if (seller) {
      seller.kycStatus = status === "approved" ? "approved" : status === "rejected" ? "rejected" : "pending";
      if (status === "approved") { seller.role = "vendor"; seller.accountStatus = "approved"; }
      else if (status === "rejected" || status === "needs_information") { seller.role = "customer"; seller.accountStatus = "pending"; }
      await seller.save();
    }
    const documentStatus = status === "approved" ? "approved" : status === "rejected" ? "rejected" : "pending";
    await SellerKycDocument.updateMany({ sellerId: application.sellerId }, { $set: { reviewStatus: documentStatus, reviewNote: status === "needs_information" ? sellerMessage.trim() : notes.trim(), reviewedBy: req.user._id, reviewedAt: new Date() } });
    await writeAudit(req, `seller_application_${status}`, "seller_application", application._id, notes.trim(), { previousStatus, sellerId: String(application.sellerId), sellerMessage: sellerMessage.trim() });
    await notifySeller({ recipientId: application.sellerId, recipientRole: status === "approved" ? "vendor" : "customer", type: `seller_application_${status}`, title: `Seller application ${status.replaceAll("_", " ")}`, message: sellerMessage.trim() || `Your seller application is ${status.replaceAll("_", " ")}.`, targetType: "seller_application", targetId: application._id, dedupeKey: `seller-application:${application._id}:review:${application.updatedAt.getTime()}` });
    if (status === "needs_information") await notifyAdmins({ type: "seller_application_update", title: "Seller application needs information", message: `${application.shopName} has been asked for more information.`, targetType: "seller_application", targetId: application._id });
    const safe = application.toObject(); delete safe.documentNumber;
    res.json({ success: true, application: safe, sellerStatus: seller?.accountStatus || "pending" });
  } catch (error) { next(error); }
});

router.get("/customers", async (req, res, next) => {
  try {
    const { page, limit } = pageOptions(req.query), filter = { role: "customer" }, search = safePattern(req.query.q);
    if (search) filter.$or = [{ name: new RegExp(search, "i") }, { email: new RegExp(search, "i") }];
    if (["active", "suspended"].includes(req.query.status)) filter.customerStatus = req.query.status;
    const [customers, total] = await Promise.all([User.find(filter).select("name email role customerStatus createdAt").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), User.countDocuments(filter)]);
    res.json({ success: true, customers: customers.map((customer) => ({ ...customer, orderCount: null })), total, page, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
});

router.patch("/customers/:customerId/status", async (req, res, next) => {
  if (!idOK(req.params.customerId)) return res.status(400).json({ success: false, message: "Invalid customer ID." });
  const { status, reason } = req.body || {};
  if (!["active", "suspended"].includes(status) || typeof reason !== "string" || !reason.trim() || reason.trim().length > 1000) return res.status(400).json({ success: false, message: "Choose active or suspended and provide a reason." });
  try {
    const user = await User.findOne({ _id: req.params.customerId, role: "customer" });
    if (!user) return res.status(404).json({ success: false, message: "Customer not found." });
    user.customerStatus = status; await user.save();
    await writeAudit(req, `customer_${status}`, "customer", user._id, reason.trim());
    res.json({ success: true, customer: { id: String(user._id), name: user.name, email: user.email, status: user.customerStatus } });
  } catch (error) { next(error); }
});

router.get("/products", async (req, res, next) => {
  try {
    const { page, limit } = pageOptions(req.query), filter = {}, search = safePattern(req.query.q);
    if (req.query.status) { if (!["active", "draft", "archived"].includes(req.query.status)) return res.status(400).json({ success: false, message: "Unknown product status." }); filter.status = req.query.status; }
    if (req.query.category) { if (!await MarketplaceCategory.exists({ name: req.query.category })) return res.status(400).json({ success: false, message: "Unknown category." }); filter.category = req.query.category; }
    if (req.query.seller) { if (!idOK(req.query.seller)) return res.status(400).json({ success: false, message: "Invalid seller ID." }); filter.sellerId = req.query.seller; }
    if (search) filter.$or = [{ title: new RegExp(search, "i") }, { description: new RegExp(search, "i") }];
    const [products, total] = await Promise.all([Product.find(filter).populate("sellerId", "name email shopName").sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Product.countDocuments(filter)]);
    res.json({ success: true, products, total, page, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
});

router.get("/products/:productId", async (req, res, next) => {
  if (!idOK(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID." });
  try { const product = await Product.findById(req.params.productId).populate("sellerId", "name email shopName").lean(); if (!product) return res.status(404).json({ success: false, message: "Product not found." }); res.json({ success: true, product }); }
  catch (error) { next(error); }
});

router.patch("/products/:productId/moderation", async (req, res, next) => {
  if (!idOK(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID." });
  const { status, reason } = req.body || {};
  if (!["active", "draft", "archived"].includes(status) || typeof reason !== "string" || !reason.trim() || reason.trim().length > 1000) return res.status(400).json({ success: false, message: "Choose a product status and provide a moderation reason." });
  try {
    const product = await Product.findById(req.params.productId);
    if (!product) return res.status(404).json({ success: false, message: "Product not found." });
    const previousStatus = product.status;
    product.status = status; product.moderationHistory.push({ status, reason: reason.trim(), adminId: req.user._id, at: new Date() }); await product.save();
    await writeAudit(req, "product_moderated", "product", product._id, reason.trim(), { sellerId: String(product.sellerId), previousStatus, status });
    res.json({ success: true, product });
  } catch (error) { next(error); }
});

router.get("/categories", async (_req, res, next) => { try { res.json({ success: true, categories: await listCategories({ includeArchived: true }) }); } catch (error) { next(error); } });
router.post("/categories", async (req, res, next) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const subcategories = req.body?.subcategories;
  if (name.length < 2 || name.length > 100 || !Array.isArray(subcategories) || subcategories.length > 40 || subcategories.some(item => typeof item !== "string" || !item.trim() || item.trim().length > 100) || new Set(subcategories.map(item => item.trim().toLowerCase())).size !== subcategories.length) return res.status(400).json({ success: false, message: "Provide a category name and up to 40 unique subcategory names." });
  try {
    const category = await MarketplaceCategory.create({ name, slug: slugify(name), subcategories: subcategories.map(item => item.trim()) });
    await writeAudit(req, "marketplace_category_created", "marketplace_category", category._id, "Category added from Admin Central.", { name: category.name, subcategoryCount: category.subcategories.length });
    res.status(201).json({ success: true, category });
  } catch (error) { if (error.code === 11000) return res.status(409).json({ success: false, message: "A category with that name or URL already exists." }); next(error); }
});
router.patch("/categories/:categoryId", async (req, res, next) => {
  if (!idOK(req.params.categoryId)) return res.status(400).json({ success: false, message: "Invalid category ID." });
  const { subcategories, status } = req.body || {};
  if ((subcategories !== undefined && (!Array.isArray(subcategories) || subcategories.length > 40 || subcategories.some(item => typeof item !== "string" || !item.trim() || item.trim().length > 100) || new Set(subcategories.map(item => item.trim().toLowerCase())).size !== subcategories.length)) || (status !== undefined && !["active", "archived"].includes(status)) || (subcategories === undefined && status === undefined)) return res.status(400).json({ success: false, message: "Provide a valid status and/or unique subcategory list." });
  try {
    const category = await MarketplaceCategory.findById(req.params.categoryId);
    if (!category) return res.status(404).json({ success: false, message: "Category not found." });
    const previousStatus = category.status, previousSubcategories = category.subcategories.slice();
    if (subcategories !== undefined) {
      const next = subcategories.map(item => item.trim());
      const removed = previousSubcategories.filter(item => !next.includes(item));
      if (removed.length && await Product.exists({ category: category.name, subcategory: { $in: removed } })) return res.status(409).json({ success: false, message: "A subcategory used by existing products cannot be removed." });
      category.subcategories = next;
    }
    if (status !== undefined) category.status = status;
    await category.save();
    await writeAudit(req, "marketplace_category_updated", "marketplace_category", category._id, "Category structure updated from Admin Central.", { previousStatus, status: category.status, previousSubcategories, subcategories: category.subcategories });
    res.json({ success: true, category });
  } catch (error) { next(error); }
});

router.get("/wallets", async (req, res, next) => {
  try {
    const { page, limit } = pageOptions(req.query), filter = { role: "vendor" }, search = safePattern(req.query.q);
    if (search) filter.$or = [{ name: new RegExp(search, "i") }, { email: new RegExp(search, "i") }, { shopName: new RegExp(search, "i") }];
    const [sellers, total] = await Promise.all([User.find(filter).select("name email shopName accountStatus").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), User.countDocuments(filter)]);
    const wallets = await Promise.all(sellers.map(async (seller) => ({ seller, balances: await walletSummary(seller._id) })));
    res.json({ success: true, wallets, total, page, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
});

router.get("/wallets/:sellerId", async (req, res, next) => {
  if (!idOK(req.params.sellerId)) return res.status(400).json({ success: false, message: "Invalid seller ID." });
  try {
    const seller = await User.findOne({ _id: req.params.sellerId, role: "vendor" }).select("name email shopName accountStatus").lean();
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found." });
    const [balances, entries] = await Promise.all([walletSummary(seller._id), SellerLedgerEntry.find({ sellerId: seller._id }).sort({ createdAt: -1 }).limit(200).lean()]);
    res.json({ success: true, seller, balances, entries });
  } catch (error) { next(error); }
});

router.get("/transactions", async (req, res, next) => {
  try {
    const { page, limit } = pageOptions(req.query), filter = {};
    if (idOK(req.query.seller)) filter.sellerId = req.query.seller;
    else if (idOK(req.query.q)) filter.sellerId = req.query.q;
    if (["deposit", "order_hold", "order_release", "withdrawal", "refund", "adjustment", "sale"].includes(req.query.type)) filter.type = req.query.type;
    const [entries, total] = await Promise.all([SellerLedgerEntry.find(filter).populate("sellerId", "name email shopName").populate("adminId", "name email").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), SellerLedgerEntry.countDocuments(filter)]);
    res.json({ success: true, entries, total, page, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
});

router.post("/wallets/:sellerId/adjustments", async (req, res, next) => {
  if (!idOK(req.params.sellerId)) return res.status(400).json({ success: false, message: "Invalid seller ID." });
  const amount = Number(req.body?.amount), direction = req.body?.direction, reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "", currency = String(req.body?.currency || "USD").toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0 || cents(amount) !== amount || amount > 100000000 || !["credit", "debit"].includes(direction) || !reason || reason.length > 1000 || !/^[A-Z]{3,8}$/.test(currency)) return res.status(400).json({ success: false, message: "Enter a positive amount (up to two decimals), currency, direction, and reason." });
  try {
    const seller = await User.findOne({ _id: req.params.sellerId, role: "vendor" }).select("_id");
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found." });
    const result = await withWalletTransaction(async (session) => {
      const movement = await applyLedgerMovement({ sellerId: seller._id, currency, type: "adjustment", amount, availableDelta: direction === "credit" ? amount : -amount, description: "Administrator wallet adjustment", reason, adminId: req.user._id, idempotencyKey: `admin-adjustment:${new mongoose.Types.ObjectId()}`, session });
      await writeAudit(req, "wallet_adjustment", "seller", seller._id, reason, { amount, currency, direction, ledgerEntryId: String(movement.entry._id) }, session);
      return movement;
    });
    res.status(201).json({ success: true, entry: result.entry, wallet: result.wallet });
  } catch (error) { next(error); }
});

router.get("/money-requests", async (req, res, next) => {
  try {
    const { page, limit } = pageOptions(req.query), filter = {};
    if (["deposit", "withdrawal"].includes(req.query.kind)) filter.kind = req.query.kind;
    if (typeof req.query.status === "string" && req.query.status.length <= 32) filter.status = req.query.status;
    const q = String(req.query.q || "").trim().slice(0, 100);
    if (q) {
      const pattern = new RegExp(safePattern(q), "i");
      const sellers = await User.find({ role: "vendor", $or: [{ name: pattern }, { email: pattern }, { shopName: pattern }] }).select("_id").lean();
      filter.$or = [{ txid: pattern }, { paymentReference: pattern }, { network: pattern }, { walletAddress: pattern }, { currency: pattern }, { sellerId: { $in: sellers.map(seller => seller._id) } }];
    }
    const [requests, total] = await Promise.all([SellerMoneyRequest.find(filter).populate("sellerId", "name email shopName walletAddress").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), SellerMoneyRequest.countDocuments(filter)]);
    res.json({ success: true, requests, total, page, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
});

router.get("/money-requests/:requestId", async (req, res, next) => {
  if (!idOK(req.params.requestId)) return res.status(400).json({ success: false, message: "Invalid request ID." });
  try { const request = await SellerMoneyRequest.findById(req.params.requestId).populate("sellerId", "name email shopName walletAddress").lean(); if (!request) return res.status(404).json({ success: false, message: "Money request not found." }); res.json({ success: true, request }); }
  catch (error) { next(error); }
});

router.patch("/money-requests/:requestId", async (req, res, next) => {
  if (!idOK(req.params.requestId)) return res.status(400).json({ success: false, message: "Invalid request ID." });
  const { status, note = "", txid = "", network = "" } = req.body || {};
  if (typeof note !== "string" || note.length > 1000 || typeof txid !== "string" || txid.trim().length > 200 || typeof network !== "string" || network.trim().length > 80) return res.status(400).json({ success: false, message: "Request review details are invalid." });
  try {
    const request = await SellerMoneyRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Money request not found." });
    const depositStatuses = ["awaiting_payment", "payment_submitted", "under_review", "approved", "rejected", "cancelled"];
    const withdrawalStatuses = ["under_review", "approved", "rejected", "paid", "completed", "cancelled"];
    if (!(request.kind === "deposit" ? depositStatuses : withdrawalStatuses).includes(status)) return res.status(400).json({ success: false, message: "Status is not valid for this request type." });
    if (["rejected", "completed", "cancelled"].includes(request.status) || (request.kind === "deposit" && request.status === "approved") || (request.kind === "withdrawal" && request.status === "approved" && !["paid", "rejected", "cancelled"].includes(status))) return res.status(409).json({ success: false, message: "This request has already reached a final state or cannot repeat that transition." });
    if (status === "paid" && (request.kind !== "withdrawal" || request.status !== "approved" || !txid.trim())) return res.status(409).json({ success: false, message: "Approve the withdrawal first, then record a transaction reference to mark it paid." });
    if (request.kind === "deposit" && status === "approved") {
      await withWalletTransaction(async (session) => {
        const current = await SellerMoneyRequest.findOne({ _id: request._id, kind: "deposit", status: { $nin: ["approved", "rejected", "cancelled"] } }).session(session);
        if (!current) { const error = new Error("Deposit request has already been finalized."); error.status = 409; throw error; }
        await applyLedgerMovement({ sellerId: current.sellerId, currency: current.currency, type: "deposit", amount: current.amount, availableDelta: current.amount, status: "completed", description: "Manually approved deposit request", reason: note.trim(), adminId: req.user._id, relatedRequestId: current._id, idempotencyKey: `deposit-credit:${current._id}`, session });
        current.status = "approved"; current.reviewedBy = req.user._id; current.reviewedAt = new Date(); current.creditedAt = new Date(); current.adminResponse = note.trim(); if (txid.trim()) current.txid = txid.trim(); if (network.trim()) current.network = network.trim(); await current.save({ session });
        await writeAudit(req, "deposit_approved_and_credited", "seller_money_request", current._id, note.trim(), { amount: current.amount, currency: current.currency, sellerId: String(current.sellerId) }, session);
      });
    } else if (request.kind === "withdrawal" && status === "paid") {
      await withWalletTransaction(async (session) => {
        const current = await SellerMoneyRequest.findOne({ _id: request._id, kind: "withdrawal", status: "approved" }).session(session);
        if (!current) { const error = new Error("Withdrawal must be approved and unpaid."); error.status = 409; throw error; }
        await applyLedgerMovement({ sellerId: current.sellerId, currency: current.currency, type: "withdrawal", amount: current.amount, heldDelta: -current.amount, status: "completed", description: "Manually completed withdrawal", reason: note.trim(), adminId: req.user._id, relatedRequestId: current._id, idempotencyKey: `withdrawal-paid:${current._id}`, session });
        current.status = "paid"; current.reviewedBy = req.user._id; current.reviewedAt = new Date(); current.txid = txid.trim(); current.adminResponse = note.trim(); if (network.trim()) current.network = network.trim(); await current.save({ session });
        await writeAudit(req, "withdrawal_marked_paid", "seller_money_request", current._id, note.trim(), { amount: current.amount, currency: current.currency, txid: current.txid }, session);
      });
    } else if (request.kind === "withdrawal" && status === "completed") {
      const completed = await SellerMoneyRequest.findOneAndUpdate({ _id: request._id, kind: "withdrawal", status: "paid" }, { $set: { status: "completed", reviewedBy: req.user._id, reviewedAt: new Date(), ...(note.trim() ? { adminResponse: note.trim() } : {}) } }, { new: true });
      if (!completed) return res.status(409).json({ success: false, message: "Record the external payment before completing this withdrawal." });
      await writeAudit(req, "withdrawal_completed", "seller_money_request", request._id, note.trim(), { amount: request.amount, currency: request.currency, txid: request.txid });
    } else if (request.kind === "withdrawal" && ["rejected", "cancelled"].includes(status)) {
      await withWalletTransaction(async (session) => {
        const current = await SellerMoneyRequest.findOne({ _id: request._id, kind: "withdrawal", status: { $in: ["pending", "pending_review", "under_review", "approved"] } }).session(session);
        if (!current) { const error = new Error("Withdrawal can no longer be rejected or cancelled."); error.status = 409; throw error; }
        if (!current.walletReleased) await applyLedgerMovement({ sellerId: current.sellerId, currency: current.currency, type: "adjustment", amount: current.amount, availableDelta: current.amount, heldDelta: -current.amount, status: "completed", description: "Release reserved withdrawal funds", reason: note.trim() || `Withdrawal ${status}`, adminId: req.user._id, relatedRequestId: current._id, idempotencyKey: `withdrawal-release:${current._id}`, session });
        current.status = status; current.reviewedBy = req.user._id; current.reviewedAt = new Date(); current.walletReleased = true; current.adminResponse = note.trim(); await current.save({ session });
        await writeAudit(req, `withdrawal_${status}`, "seller_money_request", current._id, note.trim(), { amount: current.amount, currency: current.currency }, session);
      });
    } else {
      const previousStatus = request.status; request.status = status; request.reviewedBy = req.user._id; request.reviewedAt = new Date();
      if (txid.trim()) request.txid = txid.trim(); if (network.trim()) request.network = network.trim(); request.adminResponse = note.trim(); await request.save();
      await writeAudit(req, `${request.kind}_request_${status}`, "seller_money_request", request._id, note.trim(), { previousStatus, status, sellerId: String(request.sellerId) });
    }
    const updated = await SellerMoneyRequest.findById(request._id).populate("sellerId", "name email shopName").lean();
    await notifySeller({ recipientId: request.sellerId, type: `${request.kind}_${status}`, title: `${request.kind === "deposit" ? "Deposit" : "Withdrawal"} ${status.replaceAll("_", " ")}`, message: request.kind === "withdrawal" && status === "paid" ? "Your withdrawal was marked paid manually by an administrator." : `Your ${request.kind} request status is ${status.replaceAll("_", " ")}.`, targetType: "seller_money_request", targetId: request._id, dedupeKey: `money:${request._id}:${status}` });
    res.json({ success: true, request: updated, message: status === "approved" && request.kind === "deposit" ? "Deposit credited once through the wallet ledger." : status === "paid" ? "Withdrawal marked paid; no transfer was initiated by the system." : "Request status updated." });
  } catch (error) { next(error); }
});

router.get("/notifications", async (req, res, next) => {
  try {
    const { page, limit } = pageOptions(req.query), filter = {};
    if (req.query.unread === "true") filter.readAt = null;
    const [notifications, total, unread] = await Promise.all([AdminNotification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), AdminNotification.countDocuments(filter), AdminNotification.countDocuments({ readAt: null })]);
    res.json({ success: true, notifications, total, unread, page, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
});
router.patch("/notifications/read-all", async (_req, res, next) => {
  try { const result = await AdminNotification.updateMany({ readAt: null }, { $set: { readAt: new Date() } }); res.json({ success: true, modified: result.modifiedCount }); }
  catch (error) { next(error); }
});
router.patch("/notifications/:notificationId/read", async (req, res, next) => {
  if (!idOK(req.params.notificationId)) return res.status(400).json({ success: false, message: "Invalid notification ID." });
  try { const notification = await AdminNotification.findByIdAndUpdate(req.params.notificationId, { $set: { readAt: new Date() } }, { new: true }); if (!notification) return res.status(404).json({ success: false, message: "Notification not found." }); res.json({ success: true, notification }); }
  catch (error) { next(error); }
});

router.get("/audit", async (req, res, next) => {
  try { const { page, limit } = pageOptions(req.query); const [logs, total] = await Promise.all([AdminAuditLog.find().populate("adminId", "name email").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), AdminAuditLog.countDocuments()]); res.json({ success: true, logs, total, page, pages: Math.ceil(total / limit) }); }
  catch (error) { next(error); }
});

router.get("/orders/options", async (req, res, next) => {
  try {
    const [customers, sellers, products] = await Promise.all([
      User.find({ role: "customer" }).select("name email").sort({ name: 1 }).limit(500).lean(),
      User.find({ role: "vendor" }).select("name email shopName accountStatus").sort({ shopName: 1 }).limit(500).lean(),
      Product.find({ status: "active", stock: { $gt: 0 } }).select("title price stock category sellerId").populate("sellerId", "shopName name").sort({ title: 1 }).limit(1000).lean()
    ]);
    res.json({ success: true, customers, sellers, products });
  } catch (error) { next(error); }
});

router.get("/orders", async (req, res, next) => {
  try {
    const { page, limit } = pageOptions(req.query), clauses = [];
    const search = safePattern(req.query.q);
    if (search) clauses.push({ $or: [
      { orderNumber: new RegExp(search, "i") }, { "customerContact.name": new RegExp(search, "i") },
      { "customerContact.email": new RegExp(search, "i") }, { "items.titleSnapshot": new RegExp(search, "i") }
    ] });
    if (["pending", "placed", "confirmed", "processing", "packed", "shipped", "in_transit", "out_for_delivery", "delivered", "partially_fulfilled", "cancelled", "refund_requested", "refunded"].includes(req.query.status)) clauses.push({ $or: [{ status: req.query.status }, { "fulfillments.status": req.query.status }] });
    if (["unpaid", "pending", "paid", "refunded", "failed"].includes(req.query.paymentStatus)) clauses.push({ paymentStatus: req.query.paymentStatus });
    if (idOK(req.query.sellerId)) clauses.push({ "fulfillments.sellerId": req.query.sellerId });
    const dateFilter = {};
    if (req.query.from) { const from = new Date(req.query.from); if (!Number.isFinite(from.getTime())) return res.status(400).json({ success: false, message: "Invalid start date." }); dateFilter.$gte = from; }
    if (req.query.to) { const to = new Date(req.query.to); if (!Number.isFinite(to.getTime())) return res.status(400).json({ success: false, message: "Invalid end date." }); to.setHours(23, 59, 59, 999); dateFilter.$lte = to; }
    if (Object.keys(dateFilter).length) clauses.push({ createdAt: dateFilter });
    const filter = clauses.length ? { $and: clauses } : {};
    const [orders, total] = await Promise.all([Order.find(filter).populate("customerId", "name email").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Order.countDocuments(filter)]);
    res.json({ success: true, available: true, orders, total, page, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
});

router.post("/orders", async (req, res, next) => {
  const body = req.body || {};
  const checkoutKey = String(req.get("Idempotency-Key") || body.requestKey || "").trim();
  const reason = typeof body.adminNote === "string" ? body.adminNote.trim() : "";
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(checkoutKey)) return res.status(400).json({ success: false, message: "Order creation requires an idempotency key." });
  if (!reason || reason.length > 2000) return res.status(400).json({ success: false, message: "An internal order reason is required." });
  if (body.paymentStatus && !["unpaid", "pending"].includes(body.paymentStatus)) return res.status(400).json({ success: false, message: "Admin-assisted orders start unpaid or pending. Confirm real payment separately with a reference." });
  if (body.customerId && !idOK(body.customerId)) return res.status(400).json({ success: false, message: "Invalid customer ID." });
  if (body.sellerId && !idOK(body.sellerId)) return res.status(400).json({ success: false, message: "Invalid seller ID." });
  try {
    const output = await inTransaction(async (session) => {
      if (body.sellerId) {
        const requestedIds = Array.isArray(body.lines) ? body.lines.map((line) => String(line.productId)) : [];
        const ownership = await Product.countDocuments({ _id: { $in: requestedIds }, sellerId: body.sellerId, status: "active" }).session(session);
        if (ownership !== requestedIds.length || !requestedIds.length) throw Object.assign(new Error("Select active products belonging to the selected seller."), { status: 400 });
      }
      const result = await createOrderFromLines({ customerId: body.customerId || null, contact: body.contact, shippingAddress: body.shippingAddress, lines: body.lines, actorId: req.user._id, createdByAdmin: true, adminNote: reason, checkoutKey: `admin:${req.user._id}:${checkoutKey}`, session });
      if (!result.duplicate) await writeAudit(req, "admin_order_created", "order", result.order._id, reason, { orderNumber: result.order.orderNumber, customerId: body.customerId || null, total: result.order.total }, session);
      return { order: result.order, duplicate: result.duplicate };
    });
    res.status(output.duplicate ? 200 : 201).json({ success: true, duplicate: output.duplicate, order: output.order });
  } catch (error) { next(error); }
});

router.get("/orders/:orderNumber", async (req, res, next) => {
  if (!ORDER_NUMBER.test(req.params.orderNumber)) return res.status(400).json({ success: false, message: "Invalid order number." });
  try {
    const order = await Order.findOne({ orderNumber: req.params.orderNumber }).populate("customerId", "name email").populate("createdBy", "name username").populate("fulfillments.sellerId", "name shopName").lean();
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    res.json({ success: true, order });
  } catch (error) { next(error); }
});

router.patch("/orders/:orderNumber/payment", async (req, res, next) => {
  if (!ORDER_NUMBER.test(req.params.orderNumber)) return res.status(400).json({ success: false, message: "Invalid order number." });
  const paymentStatus = req.body?.paymentStatus, reference = typeof req.body?.reference === "string" ? req.body.reference.trim() : "", reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason || reason.length > 1000) return res.status(400).json({ success: false, message: "A payment review reason is required." });
  if (paymentStatus === "paid" && (!reference || reference.length > 200)) return res.status(400).json({ success: false, message: "A verified payment reference is required before confirming payment." });
  if (paymentStatus === "refunded" && (!reference || reference.length > 200)) return res.status(400).json({ success: false, message: "A completed refund reference is required." });
  if (!["paid", "refunded"].includes(paymentStatus)) return res.status(400).json({ success: false, message: "Payment status must be a confirmed payment or completed refund." });
  try {
    const order = await inTransaction(async (session) => {
      const current = await Order.findOne({ orderNumber: req.params.orderNumber }).session(session);
      if (!current) throw Object.assign(new Error("Order not found."), { status: 404 });
      if (paymentStatus === "paid") {
        if (current.paymentStatus === "paid" && current.fulfillments.every((item) => item.walletHoldStatus === "held" || item.walletHoldStatus === "released")) return current;
        if (!["unpaid", "pending"].includes(current.paymentStatus) || current.status === "cancelled") throw Object.assign(new Error("This order cannot be marked paid in its current state."), { status: 409 });
        for (const fulfillment of current.fulfillments) {
          if (fulfillment.walletHoldStatus === "none") {
            await applyLedgerMovement({ sellerId: fulfillment.sellerId, currency: current.currency, type: "order_hold", amount: fulfillment.earningAmount, heldDelta: fulfillment.earningAmount, status: "completed", description: `Payment confirmed for order ${current.orderNumber}`, reason, adminId: req.user._id, relatedOrderId: current._id, idempotencyKey: `order-hold:${current._id}:${fulfillment._id}`, session });
            fulfillment.walletHoldStatus = "held"; fulfillment.walletHeldAmount = fulfillment.earningAmount;
          }
          if (fulfillment.status === "placed") { const old = fulfillment.status; fulfillment.status = "confirmed"; appendStatusEvent(fulfillment, old, "confirmed", req.user._id, "Payment confirmed by admin.", true); await notifyFulfillment(current, fulfillment, "confirmed", req.user._id, session); }
        }
        const old = current.status; current.status = "confirmed"; current.paymentStatus = "paid"; current.paymentReference = reference; current.paymentConfirmedAt = new Date(); current.paymentConfirmedBy = req.user._id;
        appendStatusEvent(current, old, "confirmed", req.user._id, "Payment was manually verified by an administrator.", true);
        await saveOrderNotification({ recipientId: current.customerId, recipientRole: "customer", type: "payment_confirmed", title: "Payment confirmed", message: `Payment was confirmed for order ${current.orderNumber}.`, orderId: current._id, dedupeKey: `order:${current._id}:payment:confirmed`, session });
        await writeAudit(req, "order_payment_confirmed", "order", current._id, reason, { orderNumber: current.orderNumber, reference, total: current.total }, session);
      } else {
        if (current.paymentStatus === "refunded") return current;
        if (current.status !== "refund_requested" || current.paymentStatus !== "paid") throw Object.assign(new Error("Only a paid order with a refund request can be marked refunded."), { status: 409 });
        for (const fulfillment of current.fulfillments) {
          if (fulfillment.walletHoldStatus === "held") {
            await applyLedgerMovement({ sellerId: fulfillment.sellerId, currency: current.currency, type: "refund", amount: fulfillment.walletHeldAmount, heldDelta: -fulfillment.walletHeldAmount, status: "completed", description: `Refund recorded for order ${current.orderNumber}`, reason, adminId: req.user._id, relatedOrderId: current._id, idempotencyKey: `order-refund:${current._id}:${fulfillment._id}`, session });
          } else if (fulfillment.walletHoldStatus === "released") {
            await applyLedgerMovement({ sellerId: fulfillment.sellerId, currency: current.currency, type: "refund", amount: fulfillment.earningAmount, availableDelta: -fulfillment.earningAmount, status: "completed", description: `Refund recorded for order ${current.orderNumber}`, reason, adminId: req.user._id, relatedOrderId: current._id, idempotencyKey: `order-refund:${current._id}:${fulfillment._id}`, session });
          } else throw Object.assign(new Error("A seller fulfillment has no ledger hold to refund."), { status: 409 });
          const old = fulfillment.status; fulfillment.status = "refunded"; fulfillment.walletHoldStatus = "released"; fulfillment.walletHeldAmount = 0;
          appendStatusEvent(fulfillment, old, "refunded", req.user._id, "Administrator recorded the completed refund.", true);
          await notifyFulfillment(current, fulfillment, "refunded", req.user._id, session);
        }
        const old = current.status; current.status = "refunded"; current.paymentStatus = "refunded"; current.paymentReference = reference;
        appendStatusEvent(current, old, "refunded", req.user._id, "Administrator recorded the completed refund.", true);
        await saveOrderNotification({ recipientId: current.customerId, recipientRole: "customer", type: "order_refunded", title: "Refund recorded", message: `A completed refund was recorded for order ${current.orderNumber}.`, orderId: current._id, dedupeKey: `order:${current._id}:refund:completed`, session });
        await writeAudit(req, "order_refund_recorded", "order", current._id, reason, { orderNumber: current.orderNumber, reference, total: current.total }, session);
      }
      await current.save({ session }); return current;
    });
    res.json({ success: true, order });
  } catch (error) { next(error); }
});

router.post("/orders/:orderNumber/cancel", async (req, res, next) => {
  if (!ORDER_NUMBER.test(req.params.orderNumber)) return res.status(400).json({ success: false, message: "Invalid order number." });
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason || reason.length > 1000) return res.status(400).json({ success: false, message: "A cancellation reason is required." });
  try {
    const order = await inTransaction(async (session) => {
      const current = await Order.findOne({ orderNumber: req.params.orderNumber }).session(session);
      if (!current) throw Object.assign(new Error("Order not found."), { status: 404 });
      if (current.status === "cancelled") return current;
      if (!["unpaid", "pending"].includes(current.paymentStatus) || current.fulfillments.some((item) => item.status !== "placed" || item.walletHoldStatus !== "none")) throw Object.assign(new Error("Only unpaid orders that have not entered fulfillment can be cancelled."), { status: 409 });
      for (const item of current.items) await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } }, { session });
      for (const fulfillment of current.fulfillments) { const old = fulfillment.status; fulfillment.status = "cancelled"; appendStatusEvent(fulfillment, old, "cancelled", req.user._id, "Order cancelled by an administrator.", true); await notifyFulfillment(current, fulfillment, "cancelled", req.user._id, session); }
      const old = current.status; current.status = "cancelled"; current.paymentStatus = "failed"; appendStatusEvent(current, old, "cancelled", req.user._id, "Order cancelled by an administrator.", true);
      if (current.customerId) await saveOrderNotification({ recipientId: current.customerId, recipientRole: "customer", type: "order_cancelled", title: "Order cancelled", message: `Order ${current.orderNumber} was cancelled by an administrator.`, orderId: current._id, dedupeKey: `order:${current._id}:customer:admin-cancelled`, session });
      await notifyAdmins({ type: "order_cancelled", title: "Order cancelled", message: `Order ${current.orderNumber} was cancelled by an administrator.`, targetType: "order", targetId: current._id, dedupeKey: `order:${current._id}:admin:admin-cancelled`, session });
      await writeAudit(req, "order_cancelled", "order", current._id, reason, { orderNumber: current.orderNumber, stockRestored: true }, session);
      await current.save({ session }); return current;
    });
    res.json({ success: true, order });
  } catch (error) { next(error); }
});

router.patch("/orders/:orderNumber/fulfillments/:fulfillmentId", async (req, res, next) => {
  if (!ORDER_NUMBER.test(req.params.orderNumber) || !idOK(req.params.fulfillmentId)) return res.status(400).json({ success: false, message: "Invalid order or fulfillment ID." });
  const body = req.body || {}, reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason || reason.length > 1000) return res.status(400).json({ success: false, message: "An internal admin reason is required." });
  try {
    const order = await inTransaction(async (session) => {
      const current = await Order.findOne({ orderNumber: req.params.orderNumber }).session(session);
      if (!current) throw Object.assign(new Error("Order not found."), { status: 404 });
      const fulfillment = current.fulfillments.id(req.params.fulfillmentId);
      if (!fulfillment) throw Object.assign(new Error("Seller fulfillment not found."), { status: 404 });
      const previous = fulfillment.status;
      if (body.status !== undefined) {
        const allowed = ["confirmed", "processing", "packed", "shipped", "in_transit", "out_for_delivery", "delivered"];
        if (!allowed.includes(body.status)) throw Object.assign(new Error("Invalid fulfillment status."), { status: 400 });
        if (body.status !== previous && current.paymentStatus !== "paid") throw Object.assign(new Error("Fulfillment status changes require a confirmed payment."), { status: 409 });
        if (body.status !== previous && NEXT_STATUS[previous] !== body.status && !(previous === "out_for_delivery" && body.status === "delivered") && body.override !== true) throw Object.assign(new Error("Use an explicit admin override with a reason for this status transition."), { status: 409 });
        if (body.override === true && previous !== body.status && !reason) throw Object.assign(new Error("Admin override requires a reason."), { status: 400 });
        if (body.status === "delivered" && current.paymentStatus !== "paid") throw Object.assign(new Error("Only paid orders can be marked delivered."), { status: 409 });
      }
      if (body.carrier !== undefined) fulfillment.carrier = String(body.carrier).trim().slice(0, 120);
      if (body.trackingNumber !== undefined) fulfillment.trackingNumber = String(body.trackingNumber).trim().slice(0, 160);
      if (body.trackingUrl !== undefined) fulfillment.trackingUrl = validateHttpsUrl(body.trackingUrl);
      if (body.adminNotes !== undefined) fulfillment.adminNotes = String(body.adminNotes).trim().slice(0, 1000);
      if (body.estimatedDeliveryStart !== undefined) fulfillment.estimatedDeliveryStart = new Date(body.estimatedDeliveryStart);
      if (body.estimatedDeliveryEnd !== undefined) fulfillment.estimatedDeliveryEnd = new Date(body.estimatedDeliveryEnd);
      const start = new Date(fulfillment.estimatedDeliveryStart), end = new Date(fulfillment.estimatedDeliveryEnd);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start || end > new Date(current.createdAt.getTime() + 10 * 86400000)) throw Object.assign(new Error("Estimated delivery must be a valid range within ten days of the order date."), { status: 400 });
      if (body.status === "shipped" && (!fulfillment.carrier || !fulfillment.trackingNumber)) throw Object.assign(new Error("Carrier and tracking number are required before shipment."), { status: 400 });
      if (body.status && body.status !== previous) {
        fulfillment.status = body.status;
        if (body.status === "shipped") fulfillment.shippedAt = new Date();
        if (body.status === "delivered") fulfillment.deliveredAt = new Date();
        appendStatusEvent(fulfillment, previous, body.status, req.user._id, "Shipment status updated.", true);
        if (body.status === "delivered") await releaseFulfillmentEarning(current, fulfillment, req.user._id, session);
        addMasterStatus(current, req.user._id, `Admin updated a seller fulfillment to ${body.status}.`);
        await notifyFulfillment(current, fulfillment, body.status, req.user._id, session);
      } else if (!body.status || body.status === previous) {
        appendStatusEvent(fulfillment, previous, previous, req.user._id, "Shipment details updated.", true);
        await saveOrderNotification({ recipientId: current.customerId, recipientRole: "customer", type: "tracking_updated", title: "Shipment details updated", message: `Shipment details for order ${current.orderNumber} were updated.`, orderId: current._id, fulfillmentId: fulfillment._id, dedupeKey: `order:${current._id}:tracking:${fulfillment._id}:${new mongoose.Types.ObjectId()}`, session });
      }
      await writeAudit(req, body.status && body.status !== previous ? "order_fulfillment_status_updated" : "order_fulfillment_details_updated", "order", current._id, reason, { orderNumber: current.orderNumber, fulfillmentId: String(fulfillment._id), previousStatus: previous, status: fulfillment.status }, session);
      await current.save({ session }); return current;
    });
    res.json({ success: true, order });
  } catch (error) { next(error); }
});

router.get("/sections/:section", (req, res) => {
  const supported = new Set(["reviews-disputes", "memberships", "settings"]);
  if (!supported.has(req.params.section)) return res.status(404).json({ success: false, message: "Admin section not found." });
  res.json({ success: true, section: req.params.section, available: false, items: [], message: "No records or management workflow are available in this stage." });
});

router.get("/settings", (_req, res) => res.json({ success: true, settings: { categoriesManagedFrom: "Admin Central", paymentsEnabled: false, cryptoTransfersEnabled: false } }));

module.exports = router;
