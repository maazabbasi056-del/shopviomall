const express = require("express");
const mongoose = require("mongoose");
const Product = require("../models/Product");
const Order = require("../models/Order");
const User = require("../models/User");
const SellerLedgerEntry = require("../models/SellerLedgerEntry");
const SellerMoneyRequest = require("../models/SellerMoneyRequest");
const SellerKycDocument = require("../models/SellerKycDocument");
const SellerApplication = require("../models/SellerApplication");
const PaymentMethod = require("../models/PaymentMethod");
const SellerNotification = require("../models/SellerNotification");
const { notifyAdmins } = require("../services/adminNotifications");
const { withWalletTransaction, applyLedgerMovement, readWalletSummaries } = require("../services/walletLedger");
const { requireAuth, requireDatabase, requireRole } = require("../middleware/auth");
const { normalizeProductInput, applyProductUpdate, removeFiles } = require("../services/productInput");
const { categories } = require("../config/categories");
const { sellerFulfillment } = require("./orders");

const router = express.Router();
const adminRouter = express.Router();
const idValid = (id) => mongoose.isValidObjectId(id);
const profileFor = (user) => ({
  id: String(user._id), name: user.name, role: user.role, shopName: user.shopName || "",
  shopSlug: user.shopSlug || "", shopBio: user.shopBio || "", shopImageUrl: user.shopImageUrl || "",
  walletAddress: user.walletAddress || "", emailVerified: Boolean(user.emailVerified),
  kycStatus: user.kycStatus, accountStatus: user.accountStatus,
  status: user.accountStatus === "approved" ? "Approved" : user.accountStatus === "suspended" ? "Suspended" : "Pending admin approval"
});

router.use(requireDatabase, requireAuth, requireRole("vendor"));

router.get("/profile", (req, res) => res.json({ success: true, profile: profileFor(req.user) }));
router.patch("/profile", async (req, res, next) => {
  try {
    const body = req.body || {};
    const allowed = ["name", "shopName", "shopBio", "walletAddress", "shopSlug", "shopImageUrl"];
    if (Object.keys(body).some((key) => !allowed.includes(key))) return res.status(400).json({ success: false, message: "Unsupported shop setting." });
    for (const key of Object.keys(body)) if (typeof body[key] !== "string") return res.status(400).json({ success: false, message: "Shop settings must be text." });
    const next = {
      name: String(body.name ?? req.user.name).trim(),
      shopName: String(body.shopName ?? req.user.shopName).trim(),
      shopBio: String(body.shopBio ?? req.user.shopBio).trim(),
      walletAddress: String(body.walletAddress ?? req.user.walletAddress).trim(),
      shopSlug: String(body.shopSlug ?? req.user.shopSlug).trim().toLowerCase(),
      shopImageUrl: String(body.shopImageUrl ?? req.user.shopImageUrl).trim()
    };
    if (!next.name || next.name.length > 120 || !next.shopName || next.shopName.length > 120 || next.shopBio.length > 1000 || next.walletAddress.length > 256 || next.shopSlug.length > 80) return res.status(400).json({ success: false, message: "A required value is missing or exceeds its allowed length." });
    if (next.shopSlug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(next.shopSlug)) return res.status(400).json({ success: false, message: "Shop URL may contain lowercase letters, numbers, and hyphens." });
    if (next.shopImageUrl) {
      try { if (new URL(next.shopImageUrl).protocol !== "https:") throw new Error(); }
      catch { return res.status(400).json({ success: false, message: "Shop image must use a valid HTTPS URL." }); }
    }
    if (next.shopSlug && await User.exists({ shopSlug: next.shopSlug, _id: { $ne: req.user._id } })) return res.status(409).json({ success: false, message: "That shop URL is already in use." });
    const shopChanged = ["shopName", "shopBio", "shopSlug", "shopImageUrl"].some((key) => next[key] !== (req.user[key] || ""));
    Object.assign(req.user, next);
    await req.user.save();
    if (shopChanged) {
      await notifyAdmins({ type: "seller_information_updated", title: "Seller shop information updated", message: `${req.user.shopName || "A seller"} updated shop information for review.`, targetType: "seller", targetId: req.user._id });
    }
    res.json({ success: true, profile: profileFor(req.user) });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: "That shop URL is already in use." });
    next(error);
  }
});

router.get("/products", async (req, res, next) => {
  try {
    const filter = { sellerId: req.user._id };
    const status = String(req.query.status || "all");
    if (status !== "all") {
      if (!["active", "draft", "archived"].includes(status)) return res.status(400).json({ success: false, message: "Unknown listing status." });
      filter.status = status;
    }
    const search = String(req.query.q || "").trim().slice(0, 100);
    if (search) filter.title = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    const products = await Product.find(filter).select("title description price originalPrice baseCost commissionRate category subcategory status stock images views createdAt updatedAt").sort({ createdAt: -1 }).lean();
    res.json({ success: true, products });
  } catch (error) { next(error); }
});

router.post("/products", async (req, res, next) => {
  let savedFiles = [];
  try {
    const parsed = await normalizeProductInput(req.body);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    savedFiles = parsed.savedFiles;
    const product = await Product.create({ ...parsed.fields, sellerId: req.user._id });
    res.status(201).json({ success: true, product });
  } catch (error) {
    await removeFiles(savedFiles);
    if (error.name === "ValidationError") return res.status(400).json({ success: false, message: error.message });
    if (error.code === 11000) return res.status(409).json({ success: false, message: "That SKU is already used by one of your products." });
    if (/^Images? |^A product can|^Invalid image|^An image is|^Product images/i.test(error.message || "")) return res.status(400).json({ success: false, message: error.message });
    next(error);
  }
});

router.get("/products/:productId", async (req, res, next) => {
  if (!idValid(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID." });
  try {
    const product = await Product.findOne({ _id: req.params.productId, sellerId: req.user._id });
    if (!product) return res.status(404).json({ success: false, message: "Product not found." });
    res.json({ success: true, product });
  } catch (error) { next(error); }
});

router.patch("/products/:productId", async (req, res, next) => {
  if (!idValid(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID." });
  let savedFiles = [];
  try {
    const product = await Product.findOne({ _id: req.params.productId, sellerId: req.user._id });
    if (!product) return res.status(404).json({ success: false, message: "Product not found." });
    const parsed = await normalizeProductInput(req.body, { partial: true, previousProduct: product });
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    savedFiles = parsed.savedFiles;
    await applyProductUpdate(product, parsed.fields, savedFiles);
    res.json({ success: true, product });
  } catch (error) {
    if (error.name === "ValidationError") return res.status(400).json({ success: false, message: error.message });
    if (error.code === 11000) return res.status(409).json({ success: false, message: "That SKU is already used by one of your products." });
    if (/^Images? |^A product can|^Invalid image|^An image is|^Product images/i.test(error.message || "")) return res.status(400).json({ success: false, message: error.message });
    next(error);
  }
});

router.delete("/products/:productId", async (req, res, next) => {
  if (!idValid(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID." });
  try {
    const product = await Product.findOne({ _id: req.params.productId, sellerId: req.user._id });
    if (!product) return res.status(404).json({ success: false, message: "Product not found." });
    product.status = "archived"; await product.save();
    res.json({ success: true, product, message: "Product archived." });
  } catch (error) { next(error); }
});

// The selected marketplace record is copied into the vendor's account; the source listing is never edited.
router.post("/storehouse/:productId/list", async (req, res, next) => {
  if (!idValid(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID." });
  try {
    const source = await Product.findOne({ _id: req.params.productId, status: "active" }).lean();
    if (!source) return res.status(404).json({ success: false, message: "Active marketplace product not found." });
    const product = await Product.create({ title: source.title, description: source.description, detailedDescription: source.detailedDescription, price: source.price, originalPrice: source.originalPrice, category: source.category, subcategory: source.subcategory, images: source.images, stock: source.stock, sku: "", status: "draft", sellerId: req.user._id });
    res.status(201).json({ success: true, product, message: "A separate draft listing was created in your account." });
  } catch (error) { next(error); }
});

router.get("/dashboard", async (req, res, next) => {
  try {
    const [products, sellerOrders, balances, moneyRequests] = await Promise.all([
      Product.find({ sellerId: req.user._id }).select("title description price originalPrice baseCost commissionRate category status stock views createdAt updatedAt").sort({ createdAt: -1 }).lean(),
      Order.find({ "fulfillments.sellerId": req.user._id }).sort({ createdAt: -1 }).limit(100),
      readWalletSummaries(req.user._id),
      SellerMoneyRequest.countDocuments({ sellerId: req.user._id })
    ]);
    const activeProductCount = products.filter((p) => p.status === "active").length;
    const fulfillments = sellerOrders.flatMap((order) => order.fulfillments.filter((item) => String(item.sellerId) === String(req.user._id)).map((item) => sellerFulfillment(order, item)));
    const paid = fulfillments.filter((item) => item.paymentStatus === "paid");
    const paidRevenue = paid.reduce((sum, item) => sum + Number(item.fulfillment.financials.gross || 0), 0);
    const lifetimeProfit = paid.reduce((sum, item) => sum + Number(item.fulfillment.financials.estimatedProfit || 0), 0);
    const orderCounts = { paidProcessing: paid.filter((item) => ["confirmed", "processing", "packed"].includes(item.fulfillment.status)).length, awaiting: fulfillments.filter((item) => item.paymentStatus !== "paid").length, shipped: paid.filter((item) => ["shipped", "in_transit", "out_for_delivery"].includes(item.fulfillment.status)).length, delivered: paid.filter((item) => item.fulfillment.status === "delivered").length };
    res.json({ success: true, profile: profileFor(req.user), products, statistics: { productCount: products.length, activeProductCount, draftProductCount: products.filter((p) => p.status === "draft").length, lowStockCount: products.filter((p) => p.status === "active" && p.stock <= 5).length, totalViews: products.reduce((sum, p) => sum + (p.views || 0), 0), fulfillmentCount: fulfillments.length, orderCounts, paidRevenue, lifetimeProfit }, orders: { available: true, count: fulfillments.length, message: `${fulfillments.length} seller fulfillments` }, earnings: { available: balances.some((item) => item.lifetimeRevenue || item.heldBalance || item.availableBalance), balances }, payouts: { available: true, requestCount: moneyRequests, message: "Withdrawals are requests against available balance only. Held order funds cannot be withdrawn." } });
  } catch (error) { next(error); }
});

router.get("/setup", async (req, res, next) => {
  try {
    const [documents, activeProduct, application] = await Promise.all([
      SellerKycDocument.find({ sellerId: req.user._id }).select("kind reviewStatus").lean(),
      Product.exists({ sellerId: req.user._id, status: "active" }),
      SellerApplication.findOne({ sellerId: req.user._id }).select("documentType status").lean()
    ]);
    const requiredDocs = application ? ["id_front", "selfie", ...(application.documentType === "passport" ? [] : ["id_back"])] : ["identity", "address"];
    const kycComplete = application?.status !== "rejected" && requiredDocs.every((kind) => documents.some((doc) => doc.kind === kind && doc.reviewStatus !== "rejected"));
    const checks = [
      { key: "emailVerified", label: "Email verified", complete: Boolean(req.user.emailVerified), action: "Verification is not available in this app yet." },
      { key: "kycDocuments", label: "KYC documents uploaded", complete: kycComplete, action: "Upload identity and address documents below." },
      { key: "accountApproved", label: "Account approved", complete: req.user.accountStatus === "approved", action: "Pending admin review." },
      { key: "listedProduct", label: "At least one active listed product", complete: Boolean(activeProduct), action: "Publish an eligible product from My Listings." },
      { key: "payoutWallet", label: "Payout wallet added", complete: Boolean(req.user.walletAddress?.trim()), action: "Add a wallet address in Shop Settings." },
      { key: "shopDescription", label: "Shop description added", complete: Boolean(req.user.shopBio?.trim()), action: "Add a shop description in Shop Settings." }
    ];
    res.json({ success: true, checks, completed: checks.filter((item) => item.complete).length, total: checks.length, kycStatus: req.user.kycStatus, accountStatus: req.user.accountStatus });
  } catch (error) { next(error); }
});

router.get("/application", async (req, res, next) => {
  try {
    const application = await SellerApplication.findOne({ sellerId: req.user._id }).select("shopName shopSlug description documentType status submittedAt reviewedAt sellerMessage updatedAt").lean();
    const documents = await SellerKycDocument.find({ sellerId: req.user._id }).select("kind filename reviewStatus reviewedAt").lean();
    res.json({ success: true, application, documents, accountStatus: req.user.accountStatus, kycStatus: req.user.kycStatus });
  } catch (error) { next(error); }
});

router.put("/application", async (req, res, next) => {
  try {
    const body = req.body || {};
    const documentType = body.documentType;
    const documentNumber = typeof body.documentNumber === "string" ? body.documentNumber.trim() : "";
    const required = documentType === "passport" ? ["id_front", "selfie"] : ["id_front", "id_back", "selfie"];
    if (!["national_id", "passport", "driving_license", "other"].includes(documentType) || !documentNumber || documentNumber.length > 100) return res.status(400).json({ success: false, message: "Choose a document type and provide its number." });
    const docs = await SellerKycDocument.find({ sellerId: req.user._id, kind: { $in: required }, reviewStatus: { $ne: "rejected" } }).select("kind").lean();
    if (!required.every((kind) => docs.some((doc) => doc.kind === kind))) return res.status(400).json({ success: false, message: "Upload all required identity and verification images first." });
    let application = await SellerApplication.findOne({ sellerId: req.user._id }).select("+documentNumber");
    if (application?.status === "approved") return res.status(409).json({ success: false, message: "Your seller application is already approved." });
    const shopName = String(body.shopName ?? req.user.shopName).trim();
    const shopSlug = String(body.shopSlug ?? req.user.shopSlug).trim().toLowerCase();
    const description = String(body.description ?? req.user.shopBio).trim();
    if (!shopName || shopName.length > 120 || !description || description.length > 1000 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shopSlug) || shopSlug.length > 80) return res.status(400).json({ success: false, message: "Shop name, lowercase URL slug, and description are required." });
    if (await User.exists({ shopSlug, _id: { $ne: req.user._id } })) return res.status(409).json({ success: false, message: "That shop URL is already in use." });
    if (!application) application = new SellerApplication({ sellerId: req.user._id });
    application.shopName = shopName; application.shopSlug = shopSlug; application.description = description;
    application.documentType = documentType; application.documentNumber = documentNumber; application.status = "pending";
    application.submittedAt = new Date(); application.reviewedAt = null; application.reviewedBy = null; application.sellerMessage = "";
    await application.save();
    req.user.shopName = shopName; req.user.shopSlug = shopSlug; req.user.shopBio = description; req.user.kycStatus = "pending"; req.user.accountStatus = "pending"; await req.user.save();
    await notifyAdmins({ type: "seller_application", title: "New seller application", message: `${shopName} submitted a seller verification application.`, targetType: "seller_application", targetId: application._id, dedupeKey: `seller-application:${application._id}:${application.submittedAt.getTime()}` });
    const safe = application.toObject(); delete safe.documentNumber;
    res.status(201).json({ success: true, application: safe });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: "That shop URL or seller application is already in use." });
    next(error);
  }
});

router.get("/kyc-documents", async (req, res, next) => {
  try {
    const documents = await SellerKycDocument.find({ sellerId: req.user._id }).select("kind mimeType filename reviewStatus reviewNote createdAt updatedAt").lean();
    res.json({ success: true, documents });
  } catch (error) { next(error); }
});

router.put("/kyc-documents/:kind", async (req, res, next) => {
  try {
    const kind = req.params.kind;
    if (["id_front", "id_back", "selfie"].includes(kind) && await SellerApplication.exists({ sellerId: req.user._id, status: "approved" })) return res.status(409).json({ success: false, message: "Approved identity documents cannot be replaced through this endpoint." });
    const { filename, mimeType, data } = req.body || {};
    if (!["identity", "address", "id_front", "id_back", "selfie"].includes(kind) || typeof filename !== "string" || typeof mimeType !== "string" || typeof data !== "string") return res.status(400).json({ success: false, message: "Provide an identity, address, or verification document with a supported file." });
    const match = /^data:(image\/(?:jpeg|png)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!match || match[1] !== mimeType || filename.length > 120) return res.status(400).json({ success: false, message: "Only JPEG, PNG, or PDF documents are accepted." });
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > 3 * 1024 * 1024) return res.status(400).json({ success: false, message: "KYC files must be no larger than 3 MB." });
    const valid = mimeType === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 : mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : bytes.subarray(0, 5).toString() === "%PDF-";
    if (!valid) return res.status(400).json({ success: false, message: "The uploaded file does not match its declared type." });
    const document = await SellerKycDocument.findOneAndUpdate({ sellerId: req.user._id, kind }, { $set: { filename: filename.replace(/[\\/]/g, "_").slice(0, 120), mimeType, data: bytes, reviewStatus: "pending", reviewNote: "" } }, { upsert: true, new: true, runValidators: true }).select("kind filename mimeType reviewStatus createdAt updatedAt");
    req.user.kycStatus = "pending"; await req.user.save();
    if (["id_front", "id_back", "selfie"].includes(kind)) await notifyAdmins({ type: "seller_kyc_document", title: "Seller verification document uploaded", message: `${req.user.shopName || "A seller"} uploaded a ${kind.replaceAll("_", " ")} document.`, targetType: "seller", targetId: req.user._id });
    res.json({ success: true, document });
  } catch (error) { next(error); }
});

router.get("/wallet", async (req, res, next) => {
  try {
    const entries = await SellerLedgerEntry.find({ sellerId: req.user._id }).sort({ createdAt: -1 }).limit(100).lean();
    const balances = await readWalletSummaries(req.user._id);
    res.json({ success: true, entries, hasLedgerData: entries.length > 0, balances });
  } catch (error) { next(error); }
});

router.get("/money-requests", async (req, res, next) => {
  try { const requests = await SellerMoneyRequest.find({ sellerId: req.user._id }).sort({ createdAt: -1 }).limit(100).lean(); res.json({ success: true, requests }); }
  catch (error) { next(error); }
});
router.get("/notifications", async (req, res, next) => {
  try { const notifications = await SellerNotification.find({ recipientId: req.user._id }).sort({ createdAt: -1 }).limit(50).lean(); res.json({ success: true, notifications }); }
  catch (error) { next(error); }
});

router.get("/payment-methods", async (_req, res, next) => {
  try { const methods = await PaymentMethod.find({ enabled: true }).select("asset symbol network receivingAddress instructions minimumDeposit").sort({ asset: 1, network: 1 }).lean(); res.json({ success: true, methods }); }
  catch (error) { next(error); }
});

router.post("/money-requests/:requestId/cancel", async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.requestId)) return res.status(400).json({ success: false, message: "Invalid request ID." });
  try {
    const cancelled = await withWalletTransaction(async session => {
      const request = await SellerMoneyRequest.findOne({ _id: req.params.requestId, sellerId: req.user._id, status: { $in: ["pending", "awaiting_payment", "under_review"] } }).session(session);
      if (!request) { const error = new Error("This request can no longer be cancelled."); error.status = 409; throw error; }
      if (request.kind === "withdrawal") {
        if (request.walletReleased) { const error = new Error("This withdrawal reservation has already been released."); error.status = 409; throw error; }
        await applyLedgerMovement({ sellerId: req.user._id, currency: request.currency, type: "adjustment", amount: request.amount, availableDelta: request.amount, heldDelta: -request.amount, description: "Seller cancelled withdrawal request", reason: "Unreserve available funds", relatedRequestId: request._id, idempotencyKey: `withdrawal-release:${request._id}`, session });
        request.walletReleased = true;
      }
      request.status = "cancelled"; await request.save({ session });
      return request;
    });
    res.json({ success: true, request: cancelled });
  } catch (error) { next(error); }
});

router.patch("/money-requests/:requestId/payment", async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.requestId)) return res.status(400).json({ success: false, message: "Invalid request ID." });
  const paymentReference = typeof req.body?.paymentReference === "string" ? req.body.paymentReference.trim() : "";
  const proofUrl = typeof req.body?.proofUrl === "string" ? req.body.proofUrl.trim() : "";
  if (!paymentReference || paymentReference.length > 200 || proofUrl.length > 2048 || (proofUrl && (() => { try { return new URL(proofUrl).protocol !== "https:"; } catch { return true; } })())) return res.status(400).json({ success: false, message: "Provide a transaction reference and an optional HTTPS proof link." });
  try {
    const request = await SellerMoneyRequest.findOneAndUpdate({ _id: req.params.requestId, sellerId: req.user._id, kind: "deposit", status: { $in: ["pending", "awaiting_payment"] } }, { $set: { status: "payment_submitted", paymentReference, proofUrl } }, { new: true, runValidators: true });
    if (!request) return res.status(404).json({ success: false, message: "An editable deposit request was not found." });
    await notifyAdmins({ type: "deposit_payment_submitted", title: "Deposit payment submitted", message: `${req.user.shopName || "A seller"} submitted a payment reference for review.`, targetType: "seller_money_request", targetId: request._id });
    res.json({ success: true, request });
  } catch (error) { next(error); }
});

for (const kind of ["deposit", "withdrawal"]) {
  router.post(`/money-requests/${kind}`, async (req, res, next) => {
    try {
      const amount = Number(req.body?.amount);
      const methodId = String(req.body?.paymentMethodId || "");
      const note = String(req.body?.note || "").trim();
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000 || Math.round((amount + Number.EPSILON) * 1e8) / 1e8 !== amount || note.length > 500 || !mongoose.isValidObjectId(methodId)) return res.status(400).json({ success: false, message: "Choose an enabled payment asset and enter a valid amount (up to 8 decimals)." });
      const method = await PaymentMethod.findOne({ _id: methodId, enabled: true }).lean();
      if (!method) return res.status(400).json({ success: false, message: "That payment asset or network is unavailable." });
      const precision = method.symbol === "USD" ? 2 : 8;
      if (Math.round((amount + Number.EPSILON) * 10 ** precision) / 10 ** precision !== amount) return res.status(400).json({ success: false, message: `This payment asset accepts up to ${precision} decimal places.` });
      if (kind === "deposit" && method.minimumDeposit && amount < method.minimumDeposit) return res.status(400).json({ success: false, message: `The minimum deposit for this payment method is ${method.minimumDeposit}.` });
      const currency = method.symbol;
      const walletAddress = kind === "withdrawal" ? String(req.body?.walletAddress || req.user.walletAddress || "").trim() : method.receivingAddress;
      const network = method.network;
      if (network.length > 80) return res.status(400).json({ success: false, message: "Network field exceeds the allowed length." });
      if (!walletAddress || walletAddress.length > 256) return res.status(400).json({ success: false, message: "A valid receiving address is required." });
      if (kind === "withdrawal" && req.body?.walletAddress && req.user.walletAddress !== walletAddress) { req.user.walletAddress = walletAddress; await req.user.save(); }
      let request;
      if (kind === "withdrawal") {
        await withWalletTransaction(async (session) => {
          [request] = await SellerMoneyRequest.create([{ sellerId: req.user._id, kind, amount, currency, paymentMethodId: method._id, walletAddress, network, note, status: "pending" }], { session });
          await applyLedgerMovement({ sellerId: req.user._id, currency, type: "withdrawal", amount, availableDelta: -amount, heldDelta: amount, status: "pending", description: "Reserve available funds for withdrawal review", relatedRequestId: request._id, idempotencyKey: `withdrawal-reserve:${request._id}`, session });
          await notifyAdmins({ type: "withdrawal_request", title: "New withdrawal request", message: `${req.user.shopName || "A seller"} requested ${amount.toFixed(2)} ${currency}.`, targetType: "seller_money_request", targetId: request._id, dedupeKey: `withdrawal-request:${request._id}`, session });
        });
      } else {
        request = await SellerMoneyRequest.create({ sellerId: req.user._id, kind, amount, currency, paymentMethodId: method._id, walletAddress, network, note, status: "awaiting_payment" });
        await notifyAdmins({ type: "deposit_request", title: "New deposit request", message: `${req.user.shopName || "A seller"} submitted a deposit request for ${amount.toFixed(2)} ${currency}.`, targetType: "seller_money_request", targetId: request._id, dedupeKey: `deposit-request:${request._id}` });
      }
      res.status(201).json({ success: true, request, message: kind === "withdrawal" ? "Request recorded and available funds reserved; no transfer was initiated." : "Deposit request recorded; no funds were credited." });
    } catch (error) { next(error); }
  });
}

router.get("/orders", async (req, res, next) => {
  try {
    const orders = await Order.find({ "fulfillments.sellerId": req.user._id }).sort({ createdAt: -1 }).limit(100);
    const fulfillments = orders.flatMap((order) => order.fulfillments.filter((item) => String(item.sellerId) === String(req.user._id)).map((item) => sellerFulfillment(order, item)));
    res.json({ success: true, available: true, fulfillments });
  } catch (error) { next(error); }
});
router.get("/membership", (_req, res) => res.json({ success: true, available: false, membership: null, message: "Membership plans are not available yet." }));

adminRouter.use(requireDatabase, requireAuth, requireRole("admin"));
adminRouter.get("/sellers/:sellerId/kyc-documents", async (req, res, next) => {
  if (!idValid(req.params.sellerId)) return res.status(400).json({ success: false, message: "Invalid seller ID." });
  try {
    const docs = await SellerKycDocument.find({ sellerId: req.params.sellerId }).select("kind filename mimeType reviewStatus reviewNote createdAt").lean();
    res.json({ success: true, documents: docs });
  } catch (error) { next(error); }
});
adminRouter.get("/sellers/:sellerId/kyc-documents/:kind/file", async (req, res, next) => {
  if (!idValid(req.params.sellerId) || !["identity", "address"].includes(req.params.kind)) return res.status(400).json({ success: false, message: "Invalid document request." });
  try {
    const doc = await SellerKycDocument.findOne({ sellerId: req.params.sellerId, kind: req.params.kind }).select("+data");
    if (!doc) return res.status(404).json({ success: false, message: "KYC document not found." });
    res.set("Content-Type", doc.mimeType).set("Content-Disposition", `attachment; filename="${doc.filename.replace(/["\r\n]/g, "_")}"`).set("Cache-Control", "no-store").send(doc.data);
  } catch (error) { next(error); }
});
adminRouter.get("/seller-money-requests", async (_req, res, next) => {
  try {
    const requests = await SellerMoneyRequest.find().populate("sellerId", "name email shopName").sort({ createdAt: -1 }).limit(200).lean();
    res.json({ success: true, requests: requests.map((request) => ({ ...request, seller: request.sellerId, sellerId: undefined })) });
  } catch (error) { next(error); }
});
adminRouter.patch("/seller-money-requests/:requestId/status", async (req, res, next) => {
  if (!idValid(req.params.requestId)) return res.status(400).json({ success: false, message: "Invalid request ID." });
  const { status } = req.body || {};
  if (!["approved", "rejected", "cancelled"].includes(status)) return res.status(400).json({ success: false, message: "A valid review status is required." });
  try {
    const request = await SellerMoneyRequest.findOneAndUpdate({ _id: req.params.requestId, status: "pending_review" }, { $set: { status, reviewedAt: new Date(), reviewedBy: req.user._id } }, { new: true, runValidators: true });
    if (!request) return res.status(404).json({ success: false, message: "Pending money request not found." });
    res.json({ success: true, request, message: "Request status updated; no funds were transferred." });
  } catch (error) { next(error); }
});
adminRouter.patch("/sellers/:sellerId/status", async (req, res, next) => {
  if (!idValid(req.params.sellerId)) return res.status(400).json({ success: false, message: "Invalid seller ID." });
  const { accountStatus, kycStatus } = req.body || {};
  if (!(["pending", "approved", "suspended"].includes(accountStatus)) || !(["not_submitted", "pending", "approved", "rejected"].includes(kycStatus))) return res.status(400).json({ success: false, message: "Provide valid account and KYC statuses." });
  try {
    const user = await User.findOneAndUpdate({ _id: req.params.sellerId, role: "vendor" }, { $set: { accountStatus, kycStatus } }, { new: true, runValidators: true });
    if (!user) return res.status(404).json({ success: false, message: "Vendor account not found." });
    await SellerKycDocument.updateMany({ sellerId: user._id }, { $set: { reviewStatus: kycStatus === "approved" ? "approved" : kycStatus === "rejected" ? "rejected" : "pending" } });
    res.json({ success: true, profile: profileFor(user) });
  } catch (error) { next(error); }
});

module.exports = { router, adminRouter };
