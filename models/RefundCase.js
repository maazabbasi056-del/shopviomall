const mongoose = require("mongoose");
const eventSchema = new mongoose.Schema({ status: { type: String, required: true }, note: { type: String, default: "", maxlength: 1000 }, actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, at: { type: Date, default: Date.now } }, { _id: true });
const refundCaseSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, unique: true, index: true }, orderNumber: { type: String, required: true, index: true }, customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true }, amount: { type: Number, required: true, min: 0 }, currency: { type: String, default: "USD", maxlength: 8 }, reason: { type: String, required: true, maxlength: 1000 },
  status: { type: String, enum: ["pending", "approved", "processing", "completed", "rejected", "cancelled"], default: "pending", index: true }, externalReference: { type: String, default: "", maxlength: 200 }, adminNotes: { type: String, default: "", maxlength: 2000 }, history: [eventSchema]
}, { timestamps: true });
refundCaseSchema.index({ status: 1, createdAt: -1 });
module.exports = mongoose.models.RefundCase || mongoose.model("RefundCase", refundCaseSchema);
