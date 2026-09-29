const express = require("express");
const mongoose = require("mongoose");
const CustomerAccountData = require("../models/CustomerAccountData");
const User = require("../models/User");
const Product = require("../models/Product");
const Order = require("../models/Order");
const SellerNotification = require("../models/SellerNotification");
const { sanitizeCustomerOrder } = require("../services/orders");
const { requireDatabase, requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireDatabase, requireAuth, requireRole("customer"));

async function getAccount(userId) {
  let data = await CustomerAccountData.findOne({ userId });
  if (!data) data = await CustomerAccountData.create({ userId });
  return data;
}

router.get("/profile", async (req, res, next) => {
  try {
    const [user, data] = await Promise.all([User.findById(req.user._id).select("name email createdAt"), getAccount(req.user._id)]);
    res.json({ success: true, profile: { name: user.name, email: user.email, createdAt: user.createdAt, firstName: data.firstName, lastName: data.lastName, phone: data.phone } });
  } catch (error) { next(error); }
});

router.patch("/profile", async (req, res, next) => {
  const { firstName, lastName, phone } = req.body || {};
  if ([firstName, lastName, phone].some((value) => value !== undefined && typeof value !== "string") || String(firstName || "").length > 60 || String(lastName || "").length > 60 || String(phone || "").length > 40) return res.status(400).json({ success: false, message: "Profile fields are invalid." });
  try {
    const data = await getAccount(req.user._id);
    if (firstName !== undefined) data.firstName = firstName.trim();
    if (lastName !== undefined) data.lastName = lastName.trim();
    if (phone !== undefined) data.phone = phone.trim();
    await data.save();
    const user = await User.findById(req.user._id);
    if (firstName !== undefined || lastName !== undefined) user.name = `${data.firstName} ${data.lastName}`.trim() || user.name;
    await user.save();
    res.json({ success: true, profile: { firstName: data.firstName, lastName: data.lastName, phone: data.phone } });
  } catch (error) { next(error); }
});

router.get("/addresses", async (req, res, next) => {
  try { const data = await getAccount(req.user._id); res.json({ success: true, addresses: data.addresses }); }
  catch (error) { next(error); }
});

router.post("/addresses", async (req, res, next) => {
  const input = req.body || {};
  const fields = ["recipient", "line1", "city", "country"];
  if (fields.some((key) => typeof input[key] !== "string" || !input[key].trim()) || ["label", "recipient", "line1", "line2", "city", "region", "postalCode", "country"].some((key) => input[key] !== undefined && typeof input[key] !== "string")) return res.status(400).json({ success: false, message: "Recipient, address, city, and country are required." });
  try {
    const data = await getAccount(req.user._id);
    if (data.addresses.length >= 20) return res.status(400).json({ success: false, message: "You can save up to 20 addresses." });
    const address = Object.fromEntries(["label", "recipient", "line1", "line2", "city", "region", "postalCode", "country"].map((key) => [key, String(input[key] || "").trim()]));
    address.isDefault = input.isDefault === true || data.addresses.length === 0;
    if (address.isDefault) data.addresses.forEach((item) => { item.isDefault = false; });
    data.addresses.push(address); await data.save();
    res.status(201).json({ success: true, addresses: data.addresses });
  } catch (error) { next(error); }
});

router.delete("/addresses/:addressId", async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.addressId)) return res.status(400).json({ success: false, message: "Invalid address ID." });
  try { const data = await getAccount(req.user._id); data.addresses = data.addresses.filter((item) => String(item._id) !== req.params.addressId); await data.save(); res.json({ success: true, addresses: data.addresses }); }
  catch (error) { next(error); }
});

router.patch("/addresses/:addressId/default", async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.addressId)) return res.status(400).json({ success: false, message: "Invalid address ID." });
  try {
    const data = await getAccount(req.user._id); const address = data.addresses.id(req.params.addressId);
    if (!address) return res.status(404).json({ success: false, message: "Address not found." });
    data.addresses.forEach(item => { item.isDefault = String(item._id) === req.params.addressId; }); await data.save(); res.json({ success: true, addresses: data.addresses });
  } catch (error) { next(error); }
});

router.get("/wishlist", async (req, res, next) => {
  try { const data = await getAccount(req.user._id); const products = await Product.find({ _id: { $in: data.wishlist }, status: "active" }).select("title price originalPrice images category subcategory").lean(); res.json({ success: true, products }); }
  catch (error) { next(error); }
});

router.post("/wishlist/:productId", async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID." });
  try {
    if (!await Product.exists({ _id: req.params.productId, status: "active" })) return res.status(404).json({ success: false, message: "Active product not found." });
    const data = await getAccount(req.user._id); if (!data.wishlist.some((id) => String(id) === req.params.productId)) data.wishlist.push(req.params.productId); await data.save();
    res.json({ success: true, count: data.wishlist.length });
  } catch (error) { next(error); }
});

router.delete("/wishlist/:productId", async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID." });
  try { const data = await getAccount(req.user._id); data.wishlist = data.wishlist.filter((id) => String(id) !== req.params.productId); await data.save(); res.json({ success: true, count: data.wishlist.length }); }
  catch (error) { next(error); }
});

router.get("/orders", async (req, res, next) => {
  try { const orders = await Order.find({ customerId: req.user._id }).sort({ createdAt: -1 }).limit(100).lean(); res.json({ success: true, orders: orders.map(sanitizeCustomerOrder) }); }
  catch (error) { next(error); }
});
router.get("/notifications", async (req, res, next) => {
  try { const notifications = await SellerNotification.find({ recipientId: req.user._id }).sort({ createdAt: -1 }).limit(50).lean(); res.json({ success: true, notifications }); }
  catch (error) { next(error); }
});

module.exports = router;
