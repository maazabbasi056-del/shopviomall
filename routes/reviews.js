const express = require("express");
const mongoose = require("mongoose");
const ProductReview = require("../models/ProductReview");
const Product = require("../models/Product");
const Order = require("../models/Order");
const { requireDatabase, requireAuth, requireRole } = require("../middleware/auth");
const { recordAdminAction } = require("../services/adminAudit");

const router = express.Router();
router.use(requireDatabase);
const idOK = mongoose.isValidObjectId;
function summary(rows) { return rows[0] || { average: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } }; }

router.get("/eligible/:productId", requireAuth, requireRole("customer"), async (req, res, next) => {
  if (!idOK(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID." });
  try { const orders = await Order.find({ customerId: req.user._id, paymentStatus: "paid", "fulfillments.status": "delivered", "fulfillments.items.productId": req.params.productId }).select("orderNumber fulfillments.items.productId fulfillments.status").sort({ createdAt: -1 }).lean(); const reviewed = await ProductReview.exists({ customerId: req.user._id, productId: req.params.productId }); res.json({ success: true, eligibleOrders: reviewed ? [] : orders.filter(order => order.fulfillments.some(f => f.status === "delivered" && f.items.some(item => String(item.productId) === req.params.productId))).map(order => ({ orderNumber: order.orderNumber })) }); }
  catch (error) { next(error); }
});

router.get("/product/:productId", async (req, res, next) => {
  if (!idOK(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID." });
  try {
    const [reviews, totals] = await Promise.all([
      ProductReview.find({ productId: req.params.productId, status: "published" }).populate("customerId", "name").sort({ createdAt: -1 }).limit(50).lean(),
      ProductReview.aggregate([{ $match: { productId: new mongoose.Types.ObjectId(req.params.productId), status: "published" } }, { $group: { _id: "$rating", count: { $sum: 1 }, average: { $avg: "$rating" } } }])
    ]);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let count = 0, total = 0;
    for (const row of totals) { distribution[row._id] = row.count; count += row.count; total += row._id * row.count; }
    res.json({ success: true, summary: { average: count ? Math.round(total / count * 100) / 100 : 0, count, distribution }, reviews: reviews.map(({ customerId, ...review }) => ({ ...review, customer: { name: customerId?.name || "Verified customer" } })) });
  } catch (error) { next(error); }
});

router.get("/mine", requireAuth, requireRole("customer"), async (req, res, next) => {
  try { const reviews = await ProductReview.find({ customerId: req.user._id }).populate("productId", "title images status").sort({ updatedAt: -1 }).limit(100).lean(); res.json({ success: true, reviews }); }
  catch (error) { next(error); }
});

router.post("/", requireAuth, requireRole("customer"), async (req, res, next) => {
  const { productId, orderNumber, rating, title = "", comment } = req.body || {};
  if (!idOK(productId) || typeof orderNumber !== "string" || !/^SVM-\d{8}-[A-Z0-9]{8}$/.test(orderNumber) || !Number.isInteger(Number(rating)) || Number(rating) < 1 || Number(rating) > 5 || typeof title !== "string" || title.length > 120 || typeof comment !== "string" || !comment.trim() || comment.trim().length > 3000) return res.status(400).json({ success: false, message: "Product, order, 1–5 rating, and review comment are required." });
  try {
    const order = await Order.findOne({ orderNumber, customerId: req.user._id, paymentStatus: "paid" }).lean();
    const eligible = order?.fulfillments.find(f => f.status === "delivered" && f.items.some(item => String(item.productId) === productId));
    if (!eligible) return res.status(403).json({ success: false, message: "Reviews are available only for delivered products you purchased." });
    const product = await Product.findById(productId).select("sellerId").lean();
    if (!product) return res.status(404).json({ success: false, message: "Product not found." });
    const review = await ProductReview.create({ productId, sellerId: product.sellerId, customerId: req.user._id, orderId: order._id, fulfillmentId: eligible._id, rating: Number(rating), title: title.trim(), comment: comment.trim(), verifiedPurchase: true });
    res.status(201).json({ success: true, review });
  } catch (error) { if (error.code === 11000) return res.status(409).json({ success: false, message: "You have already reviewed this product." }); next(error); }
});

router.patch("/:reviewId", requireAuth, requireRole("customer"), async (req, res, next) => {
  if (req.params.reviewId === "admin") return next();
  if (!idOK(req.params.reviewId)) return res.status(400).json({ success: false, message: "Invalid review ID." });
  const { rating, title = "", comment } = req.body || {};
  if (!Number.isInteger(Number(rating)) || Number(rating) < 1 || Number(rating) > 5 || typeof title !== "string" || title.length > 120 || typeof comment !== "string" || !comment.trim() || comment.trim().length > 3000) return res.status(400).json({ success: false, message: "Review fields are invalid." });
  try { const review = await ProductReview.findOneAndUpdate({ _id: req.params.reviewId, customerId: req.user._id }, { $set: { rating: Number(rating), title: title.trim(), comment: comment.trim() } }, { returnDocument: "after", runValidators: true }); if (!review) return res.status(404).json({ success: false, message: "Review not found." }); res.json({ success: true, review }); }
  catch (error) { next(error); }
});
router.delete("/:reviewId", requireAuth, requireRole("customer"), async (req, res, next) => {
  if (req.params.reviewId === "admin") return next();
  if (!idOK(req.params.reviewId)) return res.status(400).json({ success: false, message: "Invalid review ID." });
  try { const result = await ProductReview.deleteOne({ _id: req.params.reviewId, customerId: req.user._id }); if (!result.deletedCount) return res.status(404).json({ success: false, message: "Review not found." }); res.json({ success: true }); }
  catch (error) { next(error); }
});
router.get("/seller", requireAuth, requireRole("vendor"), async (req, res, next) => {
  try { const reviews = await ProductReview.find({ sellerId: req.user._id, status: "published" }).select("productId customerId rating title comment verifiedPurchase createdAt").populate("productId", "title").populate("customerId", "name").sort({ createdAt: -1 }).limit(100).lean(); res.json({ success: true, reviews: reviews.map(({ customerId, ...r }) => ({ ...r, customer: { name: customerId?.name || "Verified customer" } })) }); }
  catch (error) { next(error); }
});
router.get("/admin", requireAuth, requireRole("admin"), async (req, res, next) => {
  try { const page = Math.max(1, Math.min(Number.parseInt(req.query.page, 10) || 1, 10000)), limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 25, 100)); const filter = req.query.status && ["published", "hidden", "removed"].includes(req.query.status) ? { status: req.query.status } : {}; const [reviews, total] = await Promise.all([ProductReview.find(filter).populate("customerId", "name").populate("sellerId", "shopName").populate("productId", "title").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), ProductReview.countDocuments(filter)]); res.json({ success: true, reviews, total, page, pages: Math.ceil(total / limit) }); }
  catch (error) { next(error); }
});
router.patch("/admin/:reviewId", requireAuth, requireRole("admin"), async (req, res, next) => {
  if (!idOK(req.params.reviewId)) return res.status(400).json({ success: false, message: "Invalid review ID." });
  const { status, reason } = req.body || {};
  if (!["published", "hidden", "removed"].includes(status) || typeof reason !== "string" || !reason.trim() || reason.length > 1000) return res.status(400).json({ success: false, message: "Moderation status and reason are required." });
  try { const review = await ProductReview.findByIdAndUpdate(req.params.reviewId, { $set: { status, moderationReason: reason.trim(), moderatedBy: req.user._id, moderatedAt: new Date() } }, { returnDocument: "after", runValidators: true }); if (!review) return res.status(404).json({ success: false, message: "Review not found." }); await recordAdminAction({ adminId: req.user._id, action: "product_review_moderated", targetType: "product_review", targetId: review._id, reason: reason.trim(), details: { status, productId: String(review.productId) } }); res.json({ success: true, review }); }
  catch (error) { next(error); }
});
module.exports = router;
