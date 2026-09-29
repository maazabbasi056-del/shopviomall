const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Product = require("../models/Product");
const User = require("../models/User");
const Cart = require("../models/Cart");
const OrderNotification = require("../models/OrderNotification");
const { notifyAdmins } = require("./adminNotifications");

const cents = (value) => Math.round(Number(value) * 100) / 100;
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

function validateAddress(source = {}) {
  const address = {};
  for (const key of ["recipient", "line1", "line2", "city", "region", "postalCode", "country"]) {
    const value = source[key] == null ? "" : String(source[key]).trim();
    const limits = { recipient: 120, line1: 200, line2: 200, city: 100, region: 100, postalCode: 32, country: 100 };
    if (value.length > limits[key]) throw badRequest(`Shipping ${key} is too long.`);
    address[key] = value;
  }
  for (const key of ["recipient", "line1", "city", "country"]) {
    if (!address[key]) throw badRequest(`Shipping ${key} is required.`);
  }
  return address;
}

function validateContact(source = {}, user) {
  const contact = {
    name: String(source.name || user?.name || "").trim(),
    email: String(source.email || user?.email || "").trim().toLowerCase(),
    phone: String(source.phone || "").trim()
  };
  if (!contact.name || contact.name.length > 120) throw badRequest("A valid customer contact name is required.");
  if (contact.email.length > 254 || (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email))) throw badRequest("Enter a valid contact email.");
  if (contact.phone.length > 40) throw badRequest("Contact phone is too long.");
  return contact;
}

function validateLines(lines) {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 40) throw badRequest("Add between one and forty products to the order.");
  const quantities = new Map();
  for (const line of lines) {
    if (!mongoose.isValidObjectId(line?.productId)) throw badRequest("An order item has an invalid product ID.");
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw badRequest("Product quantity must be a whole number from 1 to 1000.");
    const id = String(line.productId);
    quantities.set(id, (quantities.get(id) || 0) + quantity);
  }
  for (const quantity of quantities.values()) if (quantity > 1000) throw badRequest("Combined product quantity is too large.");
  return [...quantities].map(([productId, quantity]) => ({ productId, quantity }));
}

function newOrderNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `SVM-${date}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

async function saveOrderNotification({ recipientId, recipientRole, type, title, message, orderId, fulfillmentId = null, dedupeKey, session }) {
  if (await OrderNotification.exists({ dedupeKey }).session(session)) return;
  try {
    await OrderNotification.create([{ recipientId, recipientRole, type, title, message, orderId, fulfillmentId, dedupeKey }], { session });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
}

async function createOrderFromLines({ customerId = null, contact, shippingAddress, lines, actorId, createdByAdmin = false, adminNote = "", checkoutKey = "", session }) {
  if (checkoutKey) {
    const existing = await Order.findOne({ checkoutKey }).session(session);
    if (existing) return { order: existing, duplicate: true };
  }
  const normalizedLines = validateLines(lines);
  const address = validateAddress(shippingAddress);
  const customer = customerId ? await User.findOne({ _id: customerId, role: "customer" }).session(session) : null;
  if (customerId && !customer) throw Object.assign(new Error("Customer account was not found."), { status: 404 });
  const customerContact = validateContact(contact, customer);
  const products = await Product.find({ _id: { $in: normalizedLines.map((line) => line.productId) }, status: "active" }).session(session).lean();
  if (products.length !== normalizedLines.length) throw badRequest("One or more products are unavailable.");
  const sellers = await User.find({ _id: { $in: products.map((product) => product.sellerId) }, role: "vendor" }).select("name shopName accountStatus").session(session).lean();
  const sellerById = new Map(sellers.map((seller) => [String(seller._id), seller]));
  const productById = new Map(products.map((product) => [String(product._id), product]));
  const grouped = new Map();
  let subtotalCents = 0;
  const orderItems = [];

  for (const line of normalizedLines) {
    const product = productById.get(line.productId);
    const seller = sellerById.get(String(product.sellerId));
    if (!seller || seller.accountStatus === "suspended") throw badRequest("A product seller is not currently able to fulfill orders.");
    if (!Number.isInteger(product.stock) || product.stock < line.quantity) {
      throw Object.assign(new Error(`${product.title} does not have enough available stock.`), { status: 409 });
    }
    const unitPrice = cents(product.price);
    const lineTotal = cents(unitPrice * line.quantity);
    const unitBaseCost = cents(product.baseCost || 0);
    const commissionRate = Number.isFinite(product.commissionRate) ? product.commissionRate : 5;
    const marketplaceFee = cents(lineTotal * commissionRate / 100);
    const sellerNet = cents(lineTotal - marketplaceFee);
    const estimatedProfit = cents(sellerNet - unitBaseCost * line.quantity);
    subtotalCents += Math.round(lineTotal * 100);
    const item = {
      productId: product._id,
      sellerId: product.sellerId,
      titleSnapshot: product.title,
      shopNameSnapshot: seller.shopName || seller.name,
      imageSnapshot: product.images?.[0] || "",
      skuSnapshot: product.sku || "",
      quantity: line.quantity,
      unitPrice,
      lineTotal,
      unitBaseCost,
      commissionRate,
      marketplaceFee,
      sellerNet,
      estimatedProfit
    };
    orderItems.push(item);
    const sellerId = String(product.sellerId);
    if (!grouped.has(sellerId)) grouped.set(sellerId, { seller, items: [], subtotalCents: 0 });
    grouped.get(sellerId).items.push(item);
    grouped.get(sellerId).subtotalCents += Math.round(lineTotal * 100);
  }

  for (const line of normalizedLines) {
    const changed = await Product.updateOne({ _id: line.productId, status: "active", stock: { $gte: line.quantity } }, { $inc: { stock: -line.quantity } }, { session });
    if (changed.modifiedCount !== 1) throw Object.assign(new Error("Stock changed during checkout. Review your cart and try again."), { status: 409 });
  }

  const now = new Date();
  const fulfillments = [...grouped.values()].map((group) => ({
    sellerId: group.seller._id,
    status: "placed",
    earningAmount: cents(group.items.reduce((sum, item) => sum + item.sellerNet, 0)),
    estimatedDeliveryStart: new Date(now.getTime() + 3 * 86400000),
    estimatedDeliveryEnd: new Date(now.getTime() + 7 * 86400000),
    items: group.items,
    statusHistory: [{ status: "placed", oldStatus: "", newStatus: "placed", note: "Order placed; awaiting payment confirmation.", actorId, visibleToCustomer: true, at: now }]
  }));
  let order;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      [order] = await Order.create([{
        orderNumber: newOrderNumber(), customerId, customerContact, shippingAddress: address,
        items: orderItems, fulfillments, subtotal: cents(subtotalCents / 100), shippingAmount: 0,
        total: cents(subtotalCents / 100), currency: "USD", status: "placed", paymentStatus: "unpaid",
        adminNotes: adminNote.slice(0, 2000), createdByAdmin, createdBy: createdByAdmin ? actorId : null,
        manualSource: createdByAdmin ? "admin_assisted" : "checkout", checkoutKey: checkoutKey || undefined,
        statusHistory: [{ status: "placed", oldStatus: "", newStatus: "placed", note: createdByAdmin ? "Admin-assisted order created; payment not confirmed." : "Checkout complete; payment not confirmed.", actorId, visibleToCustomer: true, at: now }]
      }], { session });
      break;
    } catch (error) {
      if (error.code !== 11000 || attempt === 3) throw error;
    }
  }

  for (const fulfillment of order.fulfillments) {
    await saveOrderNotification({ recipientId: fulfillment.sellerId, recipientRole: "vendor", type: "seller_order_placed", title: "New seller order", message: `Order ${order.orderNumber} is awaiting payment confirmation.`, orderId: order._id, fulfillmentId: fulfillment._id, dedupeKey: `order:${order._id}:fulfillment:${fulfillment._id}:placed`, session });
  }
  if (customerId) await saveOrderNotification({ recipientId: customerId, recipientRole: "customer", type: "order_placed", title: "Order placed", message: `Order ${order.orderNumber} was placed and is awaiting payment confirmation.`, orderId: order._id, dedupeKey: `order:${order._id}:customer:placed`, session });
  await notifyAdmins({ type: "order_placed", title: "New order placed", message: `${order.orderNumber} is awaiting payment confirmation.`, targetType: "order", targetId: order._id, dedupeKey: `order:${order._id}:admin:placed`, session });
  if (customerId) await Cart.updateOne({ customerId }, { $set: { items: [] } }, { session });
  return { order, duplicate: false };
}

function appendStatusEvent(target, oldStatus, newStatus, actorId, note = "", visibleToCustomer = true) {
  target.statusHistory.push({ status: newStatus, oldStatus, newStatus, actorId, note: String(note || "").trim().slice(0, 500), visibleToCustomer, at: new Date() });
}

function aggregateStatus(order) {
  const statuses = order.fulfillments.map((item) => item.status);
  if (statuses.length && statuses.every((status) => status === "cancelled")) return "cancelled";
  if (statuses.length && statuses.every((status) => status === "delivered")) return "delivered";
  if (statuses.some((status) => status === "refund_requested")) return "refund_requested";
  if (statuses.some((status) => status === "refunded")) return "refunded";
  if (statuses.every((status) => status === "placed")) return "placed";
  if (statuses.every((status) => status === "confirmed")) return "confirmed";
  const advanced = statuses.filter((status) => !["placed", "confirmed"].includes(status));
  return advanced.length ? "partially_fulfilled" : order.status;
}

function sanitizeCustomerOrder(order) {
  const value = order.toObject ? order.toObject() : { ...order };
  delete value.adminNotes; delete value.createdBy; delete value.createdByAdmin; delete value.checkoutKey; delete value.paymentConfirmedBy;
  const cleanItem = (item) => { const copy = item.toObject ? item.toObject() : { ...item }; copy.productId = String(copy.productId || ""); delete copy._id; delete copy.sellerId; delete copy.unitBaseCost; delete copy.commissionRate; delete copy.marketplaceFee; delete copy.sellerNet; delete copy.estimatedProfit; return copy; };
  value.items = (value.items || []).map(cleanItem);
  value.fulfillments = (value.fulfillments || []).map((fulfillment) => {
    const copy = { ...fulfillment, fulfillmentId: String(fulfillment._id) }; delete copy._id; delete copy.sellerId; delete copy.adminNotes; delete copy.sellerNotes; delete copy.walletHoldStatus; delete copy.walletHeldAmount; delete copy.earningAmount;
    copy.shopName = fulfillment.items?.[0]?.shopNameSnapshot || "ShopVioMall seller";
    copy.items = (fulfillment.items || []).map(cleanItem);
    copy.statusHistory = (fulfillment.statusHistory || []).filter((event) => event.visibleToCustomer).map((event) => { const clean = event.toObject ? event.toObject() : { ...event }; delete clean._id; delete clean.actorId; delete clean.visibleToCustomer; return clean; });
    return copy;
  });
  value.statusHistory = (value.statusHistory || []).filter((event) => event.visibleToCustomer).map((event) => { const clean = event.toObject ? event.toObject() : { ...event }; delete clean._id; delete clean.actorId; delete clean.visibleToCustomer; return clean; });
  return value;
}

module.exports = { cents, validateLines, validateAddress, validateContact, createOrderFromLines, saveOrderNotification, appendStatusEvent, aggregateStatus, sanitizeCustomerOrder };
