const mongoose = require("mongoose");

const orderNotificationSchema = new mongoose.Schema({
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  recipientRole: { type: String, enum: ["customer", "vendor", "admin"], required: true },
  type: { type: String, required: true, trim: true, maxlength: 80 },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  message: { type: String, required: true, trim: true, maxlength: 400 },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
  fulfillmentId: { type: mongoose.Schema.Types.ObjectId, default: null },
  readAt: { type: Date, default: null, index: true },
  dedupeKey: { type: String, required: true, unique: true, select: false }
}, { timestamps: true });

orderNotificationSchema.index({ recipientId: 1, createdAt: -1 });
module.exports = mongoose.models.OrderNotification || mongoose.model("OrderNotification", orderNotificationSchema);
