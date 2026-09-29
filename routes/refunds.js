const express = require("express");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const RefundCase = require("../models/RefundCase");
const { requireDatabase, requireAuth, requireRole } = require("../middleware/auth");
const { withWalletTransaction, applyLedgerMovement } = require("../services/walletLedger");
const { appendStatusEvent, saveOrderNotification } = require("../services/orders");
const { recordAdminAction } = require("../services/adminAudit");
const { notifySeller } = require("../services/sellerNotifications");
const { notifyAdmins } = require("../services/adminNotifications");
const router = express.Router(); router.use(requireDatabase);
router.get("/", requireAuth, requireRole("customer"), async (req, res, next) => { try { const rows = await RefundCase.find({ customerId: req.user._id }).sort({ createdAt: -1 }).lean(); res.json({ success: true, refunds: rows.map(({ adminNotes, history, ...row }) => ({ ...row, history: history.map(({ status, at }) => ({ status, at })) })) }); } catch (error) { next(error); } });
router.get("/admin", requireAuth, requireRole("admin"), async (req, res, next) => { try { const filter = ["pending", "approved", "processing", "completed", "rejected", "cancelled"].includes(req.query.status) ? { status: req.query.status } : {}; const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1), limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25)); const [refunds, total] = await Promise.all([RefundCase.find(filter).populate("customerId", "name").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), RefundCase.countDocuments(filter)]); res.json({ success: true, refunds, total, page, pages: Math.ceil(total / limit) }); } catch (error) { next(error); } });
router.patch("/admin/:refundId", requireAuth, requireRole("admin"), async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.refundId)) return res.status(400).json({ success: false, message: "Invalid refund ID." });
  const { status, note = "", externalReference = "" } = req.body || {};
  if (!["approved", "processing", "completed", "rejected", "cancelled"].includes(status) || typeof note !== "string" || note.trim().length > 2000 || typeof externalReference !== "string" || externalReference.trim().length > 200) return res.status(400).json({ success: false, message: "Refund status and review details are invalid." });
  try {
    if (status === "completed" && !externalReference.trim()) return res.status(400).json({ success: false, message: "Record the external refund reference before completing this refund." });
    const outcome = await withWalletTransaction(async session => {
      const refund = await RefundCase.findById(req.params.refundId).session(session); if (!refund) { const e = new Error("Refund request not found."); e.status = 404; throw e; }
      const transitions = { pending: ["approved", "rejected", "cancelled"], approved: ["processing", "rejected", "cancelled"], processing: ["completed", "rejected"] };
      if (!(transitions[refund.status] || []).includes(status)) { const e = new Error("Refund status transition is not allowed."); e.status = 409; throw e; }
      const order = await Order.findById(refund.orderId).session(session); if (!order) { const e = new Error("Associated order not found."); e.status = 404; throw e; }
      const old = refund.status; refund.status = status; refund.externalReference = externalReference.trim() || refund.externalReference; refund.adminNotes = `${refund.adminNotes}${refund.adminNotes && note.trim() ? "\n" : ""}${note.trim()}`.slice(-2000); refund.history.push({ status, note: note.trim(), actorId: req.user._id });
      if (status === "completed") {
        if (order.paymentStatus !== "paid" || order.status !== "refund_requested") { const e = new Error("Order must remain paid and under refund review to complete this refund."); e.status = 409; throw e; }
        for (const fulfillment of order.fulfillments) {
          if (fulfillment.walletHoldStatus === "held") await applyLedgerMovement({ sellerId: fulfillment.sellerId, currency: order.currency, type: "refund", amount: fulfillment.walletHeldAmount, heldDelta: -fulfillment.walletHeldAmount, status: "completed", description: `Refund recorded for order ${order.orderNumber}`, reason: note.trim(), adminId: req.user._id, relatedOrderId: order._id, idempotencyKey: `order-refund:${order._id}:${fulfillment._id}`, session });
          else if (fulfillment.walletHoldStatus === "released") await applyLedgerMovement({ sellerId: fulfillment.sellerId, currency: order.currency, type: "refund", amount: fulfillment.earningAmount, availableDelta: -fulfillment.earningAmount, status: "completed", description: `Refund recorded for order ${order.orderNumber}`, reason: note.trim(), adminId: req.user._id, relatedOrderId: order._id, idempotencyKey: `order-refund:${order._id}:${fulfillment._id}`, session });
          else { const e = new Error("A seller fulfillment has no refundable wallet earning."); e.status = 409; throw e; }
          const previous = fulfillment.status; fulfillment.status = "refunded"; fulfillment.walletHoldStatus = "released"; fulfillment.walletHeldAmount = 0; appendStatusEvent(fulfillment, previous, "refunded", req.user._id, "Admin recorded a completed refund.", true);
          await saveOrderNotification({ recipientId: fulfillment.sellerId, recipientRole: "vendor", type: "refund_completed", title: "Refund completed", message: `Refund was recorded for order ${order.orderNumber}.`, orderId: order._id, fulfillmentId: fulfillment._id, dedupeKey: `order:${order._id}:seller:refund-completed:${fulfillment._id}`, session });
        }
        const previous = order.status; order.status = "refunded"; order.paymentStatus = "refunded"; order.paymentReference = refund.externalReference; appendStatusEvent(order, previous, "refunded", req.user._id, "Admin recorded a completed refund.", true); await order.save({ session });
        await saveOrderNotification({ recipientId: refund.customerId, recipientRole: "customer", type: "refund_completed", title: "Refund completed", message: `Refund for order ${order.orderNumber} was recorded.`, orderId: order._id, dedupeKey: `order:${order._id}:refund:completed`, session });
      } else if (["rejected", "cancelled"].includes(status)) {
        const previous = order.status; const priorOrderEvent = [...order.statusHistory].reverse().find(event => event.newStatus === "refund_requested"); order.status = priorOrderEvent?.oldStatus || "confirmed"; for (const f of order.fulfillments) if (f.status === "refund_requested") { const before = f.status; const priorEvent = [...f.statusHistory].reverse().find(event => event.newStatus === "refund_requested"); f.status = priorEvent?.oldStatus || "confirmed"; appendStatusEvent(f, before, f.status, req.user._id, "Refund request was not completed.", true); } appendStatusEvent(order, previous, order.status, req.user._id, "Refund request was not completed.", true); await order.save({ session });
      }
      await refund.save({ session }); await recordAdminAction({ adminId: req.user._id, action: `refund_${status}`, targetType: "refund_case", targetId: refund._id, reason: note.trim(), details: { previousStatus: old, orderNumber: refund.orderNumber, externalReference: refund.externalReference }, session });
      return { refund, sellerIds: order.fulfillments.map(f => f.sellerId) };
    });
    for (const sellerId of outcome.sellerIds) await notifySeller({ recipientId: sellerId, type: `refund_${status}`, title: `Refund ${status}`, message: `A refund for order ${outcome.refund.orderNumber} was ${status}.`, targetType: "refund_case", targetId: outcome.refund._id, dedupeKey: `refund:${outcome.refund._id}:seller:${status}:${sellerId}` });
    res.json({ success: true, refund: outcome.refund });
  } catch (error) { next(error); }
});
module.exports = router;
