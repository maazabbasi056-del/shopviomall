const mongoose = require("mongoose");
const crypto = require("node:crypto");
const addDays = (days) => () => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

const statusEventSchema = new mongoose.Schema({
  status: { type: String, required: true, trim: true, maxlength: 40 },
  oldStatus: { type: String, default: "", trim: true, maxlength: 40 },
  newStatus: { type: String, default: "", trim: true, maxlength: 40 },
  note: { type: String, default: "", trim: true, maxlength: 500 },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  visibleToCustomer: { type: Boolean, default: false },
  at: { type: Date, default: Date.now }
}, { _id: true });

const orderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  titleSnapshot: { type: String, required: true, maxlength: 160 },
  shopNameSnapshot: { type: String, default: "", maxlength: 120 },
  imageSnapshot: { type: String, default: "", maxlength: 2048 },
  skuSnapshot: { type: String, default: "", maxlength: 80 },
  quantity: { type: Number, required: true, min: 1, validate: Number.isInteger },
  unitPrice: { type: Number, required: true, min: 0 },
  lineTotal: { type: Number, required: true, min: 0 },
  unitBaseCost: { type: Number, default: 0, min: 0 },
  commissionRate: { type: Number, default: 5, min: 0, max: 50 },
  marketplaceFee: { type: Number, default: 0, min: 0 },
  sellerNet: { type: Number, default: 0, min: 0 },
  estimatedProfit: { type: Number, default: 0 }
}, { _id: true });

const fulfillmentSchema = new mongoose.Schema({
  publicId: { type: String, default: () => crypto.randomBytes(12).toString("hex"), required: true },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["pending", "placed", "confirmed", "processing", "packed", "shipped", "in_transit", "out_for_delivery", "delivered", "cancelled", "refund_requested", "refunded"], default: "placed" },
  estimatedDeliveryStart: { type: Date, default: addDays(3) },
  estimatedDeliveryEnd: { type: Date, default: addDays(7) },
  carrier: { type: String, default: "", trim: true, maxlength: 120 },
  trackingNumber: { type: String, default: "", trim: true, maxlength: 160 },
  trackingUrl: { type: String, default: "", trim: true, maxlength: 2048 },
  sellerShipmentStatus: { type: String, default: "unfulfilled", trim: true, maxlength: 40 },
  sellerNotes: { type: String, default: "", trim: true, maxlength: 1000 },
  adminNotes: { type: String, default: "", trim: true, maxlength: 1000 },
  earningAmount: { type: Number, default: 0, min: 0 },
  walletHoldStatus: { type: String, enum: ["none", "held", "released"], default: "none" },
  walletHeldAmount: { type: Number, default: 0, min: 0 },
  shippedAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  items: [orderItemSchema],
  statusHistory: [statusEventSchema]
}, { _id: true });

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  customerContact: { name: { type: String, default: "", maxlength: 120 }, email: { type: String, default: "", maxlength: 254 }, phone: { type: String, default: "", maxlength: 40 } },
  items: [orderItemSchema],
  fulfillments: [fulfillmentSchema],
  shippingAddress: { recipient: { type: String, default: "", maxlength: 120 }, line1: { type: String, default: "", maxlength: 200 }, line2: { type: String, default: "", maxlength: 200 }, city: { type: String, default: "", maxlength: 100 }, region: { type: String, default: "", maxlength: 100 }, postalCode: { type: String, default: "", maxlength: 32 }, country: { type: String, default: "", maxlength: 100 } },
  subtotal: { type: Number, required: true, min: 0, default: 0 },
  shippingAmount: { type: Number, required: true, min: 0, default: 0 },
  total: { type: Number, required: true, min: 0 },
  currency: { type: String, default: "USD", maxlength: 8 },
  status: { type: String, enum: ["pending", "placed", "confirmed", "processing", "packed", "shipped", "in_transit", "out_for_delivery", "delivered", "partially_fulfilled", "cancelled", "refund_requested", "refunded"], default: "placed", index: true },
  paymentStatus: { type: String, enum: ["unpaid", "pending", "paid", "refunded", "failed"], default: "unpaid", index: true },
  paymentReference: { type: String, default: "", trim: true, maxlength: 200 },
  paymentConfirmedAt: { type: Date, default: null },
  paymentConfirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  estimatedDeliveryStart: { type: Date, default: addDays(3) },
  estimatedDeliveryEnd: { type: Date, default: addDays(7) },
  adminNotes: { type: String, default: "", maxlength: 2000 },
  statusHistory: [statusEventSchema],
  createdByAdmin: { type: Boolean, default: false, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  manualSource: { type: String, enum: ["checkout", "admin_assisted"], default: "checkout" },
  checkoutKey: { type: String, default: undefined, select: false }
}, { timestamps: true });

orderSchema.index({ customerId: 1, createdAt: -1 });
orderSchema.index({ "fulfillments.sellerId": 1, "fulfillments.status": 1 });
orderSchema.index({ checkoutKey: 1 }, { unique: true, sparse: true });
orderSchema.pre("validate", function () {
  const anchor = this.createdAt || new Date();
  if (this.createdByAdmin && !this.createdBy) this.invalidate("createdBy", "Admin-created orders must record the creating admin.");
  if (!this.createdByAdmin && this.manualSource === "admin_assisted") this.invalidate("createdByAdmin", "Admin-assisted orders must be marked and attributed to an admin.");
  if (this.estimatedDeliveryStart && this.estimatedDeliveryEnd && this.estimatedDeliveryEnd < this.estimatedDeliveryStart) this.invalidate("estimatedDeliveryEnd", "Delivery end must be after its start.");
  if (this.estimatedDeliveryEnd && this.estimatedDeliveryEnd > new Date(anchor.getTime() + 10 * 24 * 60 * 60 * 1000)) this.invalidate("estimatedDeliveryEnd", "Delivery estimates may not exceed ten days from order creation.");
  for (const fulfillment of this.fulfillments || []) {
    if (fulfillment.estimatedDeliveryStart && fulfillment.estimatedDeliveryEnd && fulfillment.estimatedDeliveryEnd < fulfillment.estimatedDeliveryStart) fulfillment.invalidate("estimatedDeliveryEnd", "Delivery end must be after its start.");
    if (fulfillment.estimatedDeliveryEnd && fulfillment.estimatedDeliveryEnd > new Date(anchor.getTime() + 10 * 24 * 60 * 60 * 1000)) fulfillment.invalidate("estimatedDeliveryEnd", "Delivery estimates may not exceed ten days from order creation.");
  }
});
module.exports = mongoose.models.Order || mongoose.model("Order", orderSchema);
