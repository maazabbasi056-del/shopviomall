const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  recipientRole: { type: String, enum: ["customer", "vendor"], required: true },
  type: { type: String, required: true, trim: true, maxlength: 80 },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  message: { type: String, required: true, trim: true, maxlength: 400 },
  targetType: { type: String, trim: true, maxlength: 80, default: "" },
  targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
  dedupeKey: { type: String, required: true, unique: true, select: false },
  readAt: { type: Date, default: null }
}, { timestamps: true });
schema.index({ recipientId: 1, createdAt: -1 });
module.exports = mongoose.models.SellerNotification || mongoose.model("SellerNotification", schema);