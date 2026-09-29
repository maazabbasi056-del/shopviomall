const express = require("express");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const OrderNotification = require("../models/OrderNotification");
const RefundCase = require("../models/RefundCase");
const { requireAuth, requireDatabase, requireRole } = require("../middleware/auth");
const { createOrderFromLines, saveOrderNotification, appendStatusEvent, aggregateStatus, sanitizeCustomerOrder } = require("../services/orders");
const { withWalletTransaction, applyLedgerMovement } = require("../services/walletLedger");
const { notifyAdmins } = require("../services/adminNotifications");

const router = express.Router();
const NEXT_STATUS = { pending: "processing", confirmed: "processing", processing: "packed", packed: "shipped", shipped: "in_transit", in_transit: "out_for_delivery" };
const ORDER_NUMBER = /^SVM-\d{8}-[A-Z0-9]{8}$/;
const httpError = (message, status = 400) => Object.assign(new Error(message), { status });

async function inTransaction(work) {
  const session = await mongoose.startSession();
  let result;
  try { await session.withTransaction(async () => { result = await work(session); }); return result; }
  finally { await session.endSession(); }
}

function customerContactFor(order) { return { ...order.customerContact }; }
function cleanItem(item) { const value = item.toObject ? item.toObject() : { ...item }; delete value._id; delete value.productId; delete value.sellerId; return value; }
function cleanHistory(events) { return (events || []).map((event) => { const value = event.toObject ? event.toObject() : { ...event }; delete value._id; delete value.actorId; delete value.visibleToCustomer; return value; }); }

function sellerFulfillment(order, fulfillment) {
  const financials = fulfillment.items.reduce((totals, item) => ({
    gross: totals.gross + Number(item.lineTotal || 0),
    baseCost: totals.baseCost + Number(item.unitBaseCost || 0) * Number(item.quantity || 0),
    marketplaceFee: totals.marketplaceFee + Number(item.marketplaceFee || 0),
    sellerNet: totals.sellerNet + Number(item.sellerNet ?? item.lineTotal ?? 0),
    estimatedProfit: totals.estimatedProfit + Number(item.estimatedProfit ?? item.lineTotal ?? 0)
  }), { gross: 0, baseCost: 0, marketplaceFee: 0, sellerNet: 0, estimatedProfit: 0 });
  for (const key of Object.keys(financials)) financials[key] = Math.round(financials[key] * 100) / 100;
  return {
    orderNumber: order.orderNumber,
    placedAt: order.createdAt,
    currency: order.currency,
    paymentStatus: order.paymentStatus,
    customer: customerContactFor(order),
    shippingAddress: { ...order.shippingAddress },
    fulfillment: {
      id: fulfillment.publicId, status: fulfillment.status, estimatedDeliveryStart: fulfillment.estimatedDeliveryStart,
      estimatedDeliveryEnd: fulfillment.estimatedDeliveryEnd, carrier: fulfillment.carrier,
      trackingNumber: fulfillment.trackingNumber, trackingUrl: fulfillment.trackingUrl,
      shippedAt: fulfillment.shippedAt, deliveredAt: fulfillment.deliveredAt,
      sellerNotes: fulfillment.sellerNotes, earningAmount: fulfillment.earningAmount,
      walletHoldStatus: fulfillment.walletHoldStatus, walletHeldAmount: fulfillment.walletHeldAmount,
      financials, items: fulfillment.items.map(cleanItem), statusHistory: cleanHistory(fulfillment.statusHistory)
    }
  };
}

async function notifyFulfillment(order, fulfillment, status, actorId, session) {
  const sellerTitle = status === "confirmed" ? "Order ready for fulfillment" : `Order ${status.replaceAll("_", " ")}`;
  const sellerMessage = `Order ${order.orderNumber} fulfillment is ${status.replaceAll("_", " ")}.`;
  await saveOrderNotification({ recipientId: fulfillment.sellerId, recipientRole: "vendor", type: `fulfillment_${status}`, title: sellerTitle, message: sellerMessage, orderId: order._id, fulfillmentId: fulfillment._id, dedupeKey: `order:${order._id}:fulfillment:${fulfillment._id}:status:${status}`, session });
  if (order.customerId) await saveOrderNotification({ recipientId: order.customerId, recipientRole: "customer", type: `fulfillment_${status}`, title: `Order ${status.replaceAll("_", " ")}`, message: `A seller shipment for order ${order.orderNumber} is ${status.replaceAll("_", " ")}.`, orderId: order._id, fulfillmentId: fulfillment._id, dedupeKey: `order:${order._id}:customer:${fulfillment._id}:status:${status}`, session });
  return actorId;
}

function validateHttpsUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  let parsed;
  try { parsed = new URL(url); } catch { throw httpError("Tracking URL must be a valid HTTPS URL."); }
  if (parsed.protocol !== "https:") throw httpError("Tracking URL must use HTTPS.");
  return url;
}

function addMasterStatus(order, actorId, note, visible = true) {
  const next = aggregateStatus(order);
  if (next !== order.status) {
    const previous = order.status;
    order.status = next;
    appendStatusEvent(order, previous, next, actorId, note, visible);
  }
}

async function releaseFulfillmentEarning(order, fulfillment, actorId, session) {
  if (order.paymentStatus !== "paid") throw httpError("Order payment must be confirmed before seller funds can be released.", 409);
  if (fulfillment.status !== "delivered") throw httpError("Seller funds can only be released after delivery.", 409);
  if (fulfillment.walletHoldStatus === "released") return false;
  if (fulfillment.walletHoldStatus !== "held") throw httpError("This fulfillment has no confirmed wallet hold.", 409);
  await applyLedgerMovement({
    sellerId: fulfillment.sellerId, currency: order.currency, type: "order_release", amount: fulfillment.walletHeldAmount,
    availableDelta: fulfillment.walletHeldAmount, heldDelta: -fulfillment.walletHeldAmount,
    status: "completed", description: `Delivered order ${order.orderNumber} seller fulfillment`,
    reason: "Seller fulfillment delivered", adminId: actorId, relatedOrderId: order._id,
    idempotencyKey: `order-release:${order._id}:${fulfillment._id}`, session
  });
  fulfillment.walletHoldStatus = "released";
  fulfillment.walletHeldAmount = 0;
  return true;
}

router.get("/", requireDatabase, requireAuth, requireRole("customer"), async (req, res, next) => {
  try {
    const orders = await Order.find({ customerId: req.user._id }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, orders: orders.map(sanitizeCustomerOrder) });
  } catch (error) { next(error); }
});

router.get("/notifications", requireDatabase, requireAuth, async (req, res, next) => {
  try {
    const notifications = await OrderNotification.find({ recipientId: req.user._id }).populate("orderId", "orderNumber").sort({ createdAt: -1 }).limit(50).lean();
    res.json({ success: true, notifications: notifications.map((item) => ({ id: String(item._id), type: item.type, title: item.title, message: item.message, orderNumber: item.orderId?.orderNumber || "", readAt: item.readAt, createdAt: item.createdAt })) });
  } catch (error) { next(error); }
});

router.patch("/notifications/:notificationId/read", requireDatabase, requireAuth, async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.notificationId)) return res.status(400).json({ success: false, message: "Invalid notification ID." });
  try {
    const result = await OrderNotification.updateOne({ _id: req.params.notificationId, recipientId: req.user._id }, { $set: { readAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ success: false, message: "Notification not found." });
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.post("/checkout", requireDatabase, requireAuth, requireRole("customer"), async (req, res, next) => {
  const checkoutKey = String(req.get("Idempotency-Key") || req.body?.checkoutKey || "").trim();
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(checkoutKey)) return res.status(400).json({ success: false, message: "Checkout requires a valid idempotency key." });
  try {
    const result = await inTransaction(async (session) => {
      const scopedCheckoutKey = `${req.user._id}:${checkoutKey}`;
      const previousOrder = await Order.findOne({ customerId: req.user._id, checkoutKey: scopedCheckoutKey }).session(session);
      if (previousOrder) return { order: previousOrder, duplicate: true };
      const cart = await Cart.findOne({ customerId: req.user._id }).session(session).lean();
      if (!cart?.items?.length) throw httpError("Your cart is empty.", 409);
      return createOrderFromLines({ customerId: req.user._id, contact: req.body?.contact, shippingAddress: req.body?.shippingAddress, lines: cart.items, actorId: req.user._id, checkoutKey: scopedCheckoutKey, session });
    });
    res.status(result.duplicate ? 200 : 201).json({ success: true, duplicate: result.duplicate, order: sanitizeCustomerOrder(result.order) });
  } catch (error) {
    if (error.code === 11000) {
      const existing = await Order.findOne({ customerId: req.user._id, checkoutKey: `${req.user._id}:${checkoutKey}` }).catch(() => null);
      if (existing) return res.json({ success: true, duplicate: true, order: sanitizeCustomerOrder(existing) });
    }
    next(error);
  }
});

router.get("/seller/fulfillments", requireDatabase, requireAuth, requireRole("vendor"), async (req, res, next) => {
  try {
    const orders = await Order.find({ "fulfillments.sellerId": req.user._id }).sort({ createdAt: -1 }).limit(100).lean();
    const fulfillments = orders.flatMap((order) => order.fulfillments.filter((fulfillment) => String(fulfillment.sellerId) === String(req.user._id)).map((fulfillment) => sellerFulfillment(order, fulfillment)));
    res.json({ success: true, fulfillments });
  } catch (error) { next(error); }
});

router.patch("/seller/fulfillments/:fulfillmentId", requireDatabase, requireAuth, requireRole("vendor"), async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.fulfillmentId)) return res.status(400).json({ success: false, message: "Invalid fulfillment ID." });
  const { status, carrier, trackingNumber, trackingUrl, sellerNotes, estimatedDeliveryStart, estimatedDeliveryEnd } = req.body || {};
  try {
    const output = await inTransaction(async (session) => {
      const order = await Order.findOne({ fulfillments: { $elemMatch: { publicId: req.params.fulfillmentId, sellerId: req.user._id } } }).session(session);
      if (!order) throw httpError("Seller fulfillment not found.", 404);
      const fulfillment = order.fulfillments.find((entry) => entry.publicId === req.params.fulfillmentId && String(entry.sellerId) === String(req.user._id));
      const previousTracking = JSON.stringify([fulfillment.carrier, fulfillment.trackingNumber, fulfillment.trackingUrl, fulfillment.estimatedDeliveryStart?.toISOString(), fulfillment.estimatedDeliveryEnd?.toISOString()]);
      if (order.paymentStatus !== "paid") throw httpError("Fulfillment actions are available after payment is confirmed.", 409);
      if (status) {
        if (status === "delivered" || status === "cancelled" || status === "refund_requested" || status === "refunded") throw httpError("This fulfillment status requires customer or admin action.", 403);
        if (status !== fulfillment.status && NEXT_STATUS[fulfillment.status] !== status) throw httpError("Fulfillment status must advance one step at a time.", 409);
      }
      if (carrier !== undefined) fulfillment.carrier = String(carrier).trim().slice(0, 120);
      if (trackingNumber !== undefined) fulfillment.trackingNumber = String(trackingNumber).trim().slice(0, 160);
      if (trackingUrl !== undefined) fulfillment.trackingUrl = validateHttpsUrl(trackingUrl);
      if (sellerNotes !== undefined) fulfillment.sellerNotes = String(sellerNotes).trim().slice(0, 1000);
      if (estimatedDeliveryStart !== undefined) fulfillment.estimatedDeliveryStart = new Date(estimatedDeliveryStart);
      if (estimatedDeliveryEnd !== undefined) fulfillment.estimatedDeliveryEnd = new Date(estimatedDeliveryEnd);
      const start = new Date(fulfillment.estimatedDeliveryStart), end = new Date(fulfillment.estimatedDeliveryEnd);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start || end > new Date(order.createdAt.getTime() + 10 * 86400000)) throw httpError("Estimated delivery must be a valid date range within ten days of order creation.");
      if (status === "shipped" && (!fulfillment.carrier || !fulfillment.trackingNumber)) throw httpError("Enter a carrier and tracking number before marking the order shipped.");
      if (status && status !== fulfillment.status) {
        const previous = fulfillment.status;
        fulfillment.status = status;
        if (status === "shipped") fulfillment.shippedAt = new Date();
        appendStatusEvent(fulfillment, previous, status, req.user._id, "Seller fulfillment updated.", true);
        addMasterStatus(order, req.user._id, `Seller shipment changed to ${status}.`);
        await notifyFulfillment(order, fulfillment, status, req.user._id, session);
      } else {
        const currentTracking = JSON.stringify([fulfillment.carrier, fulfillment.trackingNumber, fulfillment.trackingUrl, fulfillment.estimatedDeliveryStart?.toISOString(), fulfillment.estimatedDeliveryEnd?.toISOString()]);
        if (currentTracking !== previousTracking && order.customerId) {
          appendStatusEvent(fulfillment, fulfillment.status, fulfillment.status, req.user._id, "Shipment tracking or delivery estimate updated.", true);
          await saveOrderNotification({ recipientId: order.customerId, recipientRole: "customer", type: "tracking_updated", title: "Shipment details updated", message: `Tracking or delivery estimates changed for order ${order.orderNumber}.`, orderId: order._id, fulfillmentId: fulfillment._id, dedupeKey: `order:${order._id}:tracking:${fulfillment._id}:${new mongoose.Types.ObjectId()}`, session });
        }
      }
      await order.save({ session });
      return sellerFulfillment(order, fulfillment);
    });
    res.json({ success: true, fulfillment: output });
  } catch (error) { next(error); }
});

router.get("/:orderNumber", requireDatabase, requireAuth, requireRole("customer"), async (req, res, next) => {
  if (!ORDER_NUMBER.test(req.params.orderNumber)) return res.status(400).json({ success: false, message: "Invalid order number." });
  try {
    const order = await Order.findOne({ orderNumber: req.params.orderNumber, customerId: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    res.json({ success: true, order: sanitizeCustomerOrder(order) });
  } catch (error) { next(error); }
});

router.post("/:orderNumber/cancel", requireDatabase, requireAuth, requireRole("customer"), async (req, res, next) => {
  if (!ORDER_NUMBER.test(req.params.orderNumber)) return res.status(400).json({ success: false, message: "Invalid order number." });
  try {
    const order = await inTransaction(async (session) => {
      const current = await Order.findOne({ orderNumber: req.params.orderNumber, customerId: req.user._id }).session(session);
      if (!current) throw httpError("Order not found.", 404);
      if (current.status === "cancelled") return current;
      if (!["unpaid", "pending"].includes(current.paymentStatus) || current.fulfillments.some((item) => item.status !== "placed" || item.walletHoldStatus !== "none")) throw httpError("Only orders awaiting payment and not yet processing can be cancelled here.", 409);
      for (const item of current.items) await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } }, { session });
      for (const fulfillment of current.fulfillments) {
        const old = fulfillment.status; fulfillment.status = "cancelled";
        appendStatusEvent(fulfillment, old, "cancelled", req.user._id, "Customer cancelled before payment confirmation.", true);
        await notifyFulfillment(current, fulfillment, "cancelled", req.user._id, session);
      }
      const old = current.status; current.status = "cancelled";
      appendStatusEvent(current, old, "cancelled", req.user._id, "Customer cancelled before payment confirmation.", true);
      await saveOrderNotification({ recipientId: req.user._id, recipientRole: "customer", type: "order_cancelled", title: "Order cancelled", message: `Order ${current.orderNumber} was cancelled.`, orderId: current._id, dedupeKey: `order:${current._id}:customer:cancelled`, session });
      await notifyAdmins({ type: "order_cancelled", title: "Customer cancelled an order", message: `Order ${current.orderNumber} was cancelled before payment confirmation.`, targetType: "order", targetId: current._id, dedupeKey: `order:${current._id}:admin:cancelled`, session });
      await current.save({ session }); return current;
    });
    res.json({ success: true, order: sanitizeCustomerOrder(order) });
  } catch (error) { next(error); }
});

router.post("/:orderNumber/refund-request", requireDatabase, requireAuth, requireRole("customer"), async (req, res, next) => {
  if (!ORDER_NUMBER.test(req.params.orderNumber)) return res.status(400).json({ success: false, message: "Invalid order number." });
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason || reason.length > 500) return res.status(400).json({ success: false, message: "Enter a short reason for the refund request." });
  try {
    const order = await inTransaction(async (session) => {
      const current = await Order.findOne({ orderNumber: req.params.orderNumber, customerId: req.user._id }).session(session);
      if (!current) throw httpError("Order not found.", 404);
      if (current.paymentStatus !== "paid" || ["cancelled", "refunded", "refund_requested"].includes(current.status)) throw httpError("This order cannot accept a refund request in its current state.", 409);
      const [refund] = await RefundCase.create([{ orderId: current._id, orderNumber: current.orderNumber, customerId: req.user._id, amount: current.total, currency: current.currency, reason, history: [{ status: "pending", note: "Customer requested refund review.", actorId: req.user._id }] }], { session });
      const old = current.status; current.status = "refund_requested";
      appendStatusEvent(current, old, "refund_requested", req.user._id, reason, true);
      for (const fulfillment of current.fulfillments) {
        const previous = fulfillment.status; fulfillment.status = "refund_requested";
        appendStatusEvent(fulfillment, previous, "refund_requested", req.user._id, reason, true);
        await saveOrderNotification({ recipientId: fulfillment.sellerId, recipientRole: "vendor", type: "refund_requested", title: "Order refund requested", message: `A refund was requested for order ${current.orderNumber}.`, orderId: current._id, fulfillmentId: fulfillment._id, dedupeKey: `order:${current._id}:fulfillment:${fulfillment._id}:refund-requested`, session });
      }
      await saveOrderNotification({ recipientId: req.user._id, recipientRole: "customer", type: "refund_requested", title: "Refund request submitted", message: `Your refund request for order ${current.orderNumber} is under review.`, orderId: current._id, dedupeKey: `order:${current._id}:refund-requested`, session });
      await notifyAdmins({ type: "refund_requested", title: "Order refund requested", message: `Order ${current.orderNumber} needs refund review.`, targetType: "refund_case", targetId: refund._id, dedupeKey: `refund:${refund._id}:admin`, session });
      await current.save({ session }); return current;
    });
    res.status(201).json({ success: true, order: sanitizeCustomerOrder(order) });
  } catch (error) { next(error); }
});

router.post("/:orderNumber/fulfillments/:fulfillmentId/confirm-delivery", requireDatabase, requireAuth, requireRole("customer"), async (req, res, next) => {
  if (!ORDER_NUMBER.test(req.params.orderNumber) || !mongoose.isValidObjectId(req.params.fulfillmentId)) return res.status(400).json({ success: false, message: "Invalid order or fulfillment ID." });
  try {
    const order = await inTransaction(async (session) => {
      const current = await Order.findOne({ orderNumber: req.params.orderNumber, customerId: req.user._id }).session(session);
      if (!current) throw httpError("Order not found.", 404);
      const fulfillment = current.fulfillments.find((entry) => entry.publicId === req.params.fulfillmentId);
      if (!fulfillment) throw httpError("Seller fulfillment not found.", 404);
      if (fulfillment.status === "delivered") { await releaseFulfillmentEarning(current, fulfillment, req.user._id, session); return current; }
      if (fulfillment.status !== "out_for_delivery") throw httpError("Delivery can be confirmed once the shipment is out for delivery.", 409);
      const old = fulfillment.status; fulfillment.status = "delivered"; fulfillment.deliveredAt = new Date();
      appendStatusEvent(fulfillment, old, "delivered", req.user._id, "Customer confirmed delivery.", true);
      await releaseFulfillmentEarning(current, fulfillment, req.user._id, session);
      addMasterStatus(current, req.user._id, "A seller fulfillment was delivered.");
      await notifyFulfillment(current, fulfillment, "delivered", req.user._id, session);
      await current.save({ session }); return current;
    });
    res.json({ success: true, order: sanitizeCustomerOrder(order) });
  } catch (error) { next(error); }
});

module.exports = { router, releaseFulfillmentEarning, notifyFulfillment, appendStatusEvent, addMasterStatus, validateHttpsUrl, inTransaction, sellerFulfillment, ORDER_NUMBER, NEXT_STATUS };
