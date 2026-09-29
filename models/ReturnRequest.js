const mongoose = require("mongoose");
const eventSchema = new mongoose.Schema({ status: { type: String, required: true }, note: { type: String, default: "", maxlength: 1000 }, actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, at: { type: Date, default: Date.now } }, { _id: true });
const returnRequestSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
  orderNumber: { type: String, required: true, index: true },
  fulfillmentId: { type: mongoose.Schema.Types.ObjectId, required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  quantity: { type: Number, required: true, min: 1, validate: Number.isInteger },
  reason: { type: String, required: true, enum: ["damaged", "not_as_described", "wrong_item", "changed_mind", "other"] },
  explanation: { type: String, default: "", maxlength: 2000 },
  evidenceUrls: [{ type: String, maxlength: 2048 }],
  resolution: { type: String, enum: ["refund", "replacement", "store_credit", "undecided"], default: "undecided" },
  status: { type: String, enum: ["requested", "under_review", "approved", "rejected", "return_in_transit", "received", "resolved", "cancelled"], default: "requested", index: true },
  history: [eventSchema], adminNotes: { type: String, default: "", maxlength: 3000 }
}, { timestamps: true });
returnRequestSchema.index({ customerId: 1, orderId: 1, productId: 1, status: 1 });
returnRequestSchema.index({ sellerId: 1, status: 1, createdAt: -1 });
module.exports = mongoose.models.ReturnRequest || mongoose.model("ReturnRequest", returnRequestSchema);
