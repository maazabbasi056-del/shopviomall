const mongoose = require("mongoose");

const sellerMoneyRequestSchema = new mongoose.Schema({
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  kind: { type: String, enum: ["deposit", "withdrawal"], required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, default: "USD", trim: true, uppercase: true, maxlength: 8 },
  paymentMethodId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentMethod", default: null },
  walletAddress: { type: String, default: "", trim: true, maxlength: 256 },
  network: { type: String, default: "", trim: true, maxlength: 80 },
  note: { type: String, default: "", trim: true, maxlength: 500 },
  status: { type: String, enum: ["pending_review", "pending", "awaiting_payment", "payment_submitted", "under_review", "approved", "rejected", "paid", "completed", "cancelled"], default: "pending", index: true },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  txid: { type: String, default: "", trim: true, maxlength: 200 },
  creditedAt: { type: Date, default: null },
  walletReleased: { type: Boolean, default: false },
  paymentReference: { type: String, default: "", trim: true, maxlength: 200 },
  proofUrl: { type: String, default: "", trim: true, maxlength: 2048 },
  adminResponse: { type: String, default: "", trim: true, maxlength: 1000 }
}, { timestamps: true });

sellerMoneyRequestSchema.index({ sellerId: 1, createdAt: -1 });
module.exports = mongoose.models.SellerMoneyRequest || mongoose.model("SellerMoneyRequest", sellerMoneyRequestSchema);
