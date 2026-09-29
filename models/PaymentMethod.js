const mongoose = require("mongoose");

const paymentMethodSchema = new mongoose.Schema({
  asset: { type: String, required: true, trim: true, uppercase: true, maxlength: 24 },
  symbol: { type: String, required: true, trim: true, uppercase: true, maxlength: 12 },
  network: { type: String, required: true, trim: true, maxlength: 80 },
  receivingAddress: { type: String, required: true, trim: true, maxlength: 256 },
  enabled: { type: Boolean, default: false, index: true },
  instructions: { type: String, default: "", trim: true, maxlength: 2000 },
  minimumDeposit: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

paymentMethodSchema.index({ asset: 1, network: 1 }, { unique: true });
module.exports = mongoose.models.PaymentMethod || mongoose.model("PaymentMethod", paymentMethodSchema);
