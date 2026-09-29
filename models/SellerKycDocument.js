const mongoose = require("mongoose");

const sellerKycDocumentSchema = new mongoose.Schema({
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  kind: { type: String, enum: ["identity", "address", "id_front", "id_back", "selfie"], required: true },
  mimeType: { type: String, enum: ["image/jpeg", "image/png", "application/pdf"], required: true },
  filename: { type: String, required: true, maxlength: 120 },
  data: { type: Buffer, required: true, select: false },
  reviewStatus: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  reviewNote: { type: String, default: "", maxlength: 500 },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null }
}, { timestamps: true });

sellerKycDocumentSchema.index({ sellerId: 1, kind: 1 }, { unique: true });
module.exports = mongoose.models.SellerKycDocument || mongoose.model("SellerKycDocument", sellerKycDocumentSchema);
