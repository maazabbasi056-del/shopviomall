const mongoose = require("mongoose");

const sellerApplicationSchema = new mongoose.Schema({
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  shopName: { type: String, required: true, trim: true, maxlength: 120 },
  shopSlug: { type: String, required: true, lowercase: true, trim: true, maxlength: 80 },
  description: { type: String, required: true, trim: true, maxlength: 1000 },
  documentType: { type: String, required: true, enum: ["national_id", "passport", "driving_license", "other"] },
  documentNumber: { type: String, required: true, trim: true, maxlength: 100, select: false },
  termsAcceptedAt: { type: Date, default: null },
  status: { type: String, enum: ["pending", "under_review", "approved", "rejected", "needs_information"], default: "pending", index: true },
  submittedAt: { type: Date, default: Date.now },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  adminNotes: { type: String, default: "", trim: true, maxlength: 3000 },
  sellerMessage: { type: String, default: "", trim: true, maxlength: 1000 }
}, { timestamps: true });

sellerApplicationSchema.index({ status: 1, submittedAt: -1 });
module.exports = mongoose.models.SellerApplication || mongoose.model("SellerApplication", sellerApplicationSchema);
