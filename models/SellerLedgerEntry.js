const mongoose = require("mongoose");

const sellerLedgerEntrySchema = new mongoose.Schema({
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  type: { type: String, enum: ["sale", "order_hold", "order_release", "refund", "deposit", "withdrawal", "adjustment"], required: true },
  amount: { type: Number, required: true, min: 0 },
  availableDelta: { type: Number, default: 0 },
  heldDelta: { type: Number, default: 0 },
  currency: { type: String, default: "USD", trim: true, uppercase: true, maxlength: 8 },
  status: { type: String, enum: ["pending", "completed", "failed", "rejected"], default: "pending", index: true },
  reference: { type: String, default: "", trim: true, maxlength: 120 },
  description: { type: String, default: "", trim: true, maxlength: 300 },
  reason: { type: String, default: "", trim: true, maxlength: 1000 },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  relatedRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "SellerMoneyRequest", default: null, index: true },
  relatedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null, index: true },
  idempotencyKey: { type: String, default: "", select: false }
}, { timestamps: true });

sellerLedgerEntrySchema.index({ sellerId: 1, createdAt: -1 });
sellerLedgerEntrySchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } } });
module.exports = mongoose.models.SellerLedgerEntry || mongoose.model("SellerLedgerEntry", sellerLedgerEntrySchema);
