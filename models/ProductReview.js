const mongoose = require("mongoose");

const productReviewSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  fulfillmentId: { type: mongoose.Schema.Types.ObjectId, required: true },
  rating: { type: Number, required: true, min: 1, max: 5, validate: Number.isInteger },
  title: { type: String, default: "", trim: true, maxlength: 120 },
  comment: { type: String, required: true, trim: true, maxlength: 3000 },
  verifiedPurchase: { type: Boolean, default: true, immutable: true },
  status: { type: String, enum: ["published", "hidden", "removed"], default: "published", index: true },
  moderationReason: { type: String, default: "", maxlength: 1000 },
  moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  moderatedAt: { type: Date, default: null }
}, { timestamps: true });

productReviewSchema.index({ productId: 1, customerId: 1 }, { unique: true });
productReviewSchema.index({ sellerId: 1, status: 1, createdAt: -1 });
module.exports = mongoose.models.ProductReview || mongoose.model("ProductReview", productReviewSchema);
