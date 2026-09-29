const mongoose = require("mongoose");
const eventSchema = new mongoose.Schema({ status: { type: String, required: true }, note: { type: String, default: "", maxlength: 1000 }, actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, at: { type: Date, default: Date.now } }, { _id: true });
const orderDisputeSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true }, orderNumber: { type: String, required: true, index: true },
  fulfillmentId: { type: mongoose.Schema.Types.ObjectId, required: true }, customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true }, sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  category: { type: String, required: true, enum: ["item_not_received", "item_damaged", "incorrect_item", "refund_issue", "other"] }, description: { type: String, required: true, maxlength: 3000 }, evidenceUrls: [{ type: String, maxlength: 2048 }],
  status: { type: String, enum: ["open", "under_review", "waiting_customer", "waiting_seller", "resolved", "rejected", "closed"], default: "open", index: true }, resolution: { type: String, default: "", maxlength: 2000 }, internalNotes: { type: String, default: "", maxlength: 5000 }, history: [eventSchema]
}, { timestamps: true });
orderDisputeSchema.index({ customerId: 1, orderId: 1, fulfillmentId: 1, status: 1 });
orderDisputeSchema.index({ status: 1, createdAt: -1 });
module.exports = mongoose.models.OrderDispute || mongoose.model("OrderDispute", orderDisputeSchema);
