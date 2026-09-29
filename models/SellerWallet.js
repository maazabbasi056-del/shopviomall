const mongoose = require("mongoose");

const sellerWalletSchema = new mongoose.Schema({
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  currency: { type: String, required: true, uppercase: true, trim: true, maxlength: 8 },
  availableBalance: { type: Number, default: 0, min: 0 },
  heldBalance: { type: Number, default: 0, min: 0 },
  lifetimeRevenue: { type: Number, default: 0, min: 0 },
  totalDeposits: { type: Number, default: 0, min: 0 },
  totalWithdrawals: { type: Number, default: 0, min: 0 },
  version: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

sellerWalletSchema.index({ sellerId: 1, currency: 1 }, { unique: true });
module.exports = mongoose.models.SellerWallet || mongoose.model("SellerWallet", sellerWalletSchema);
