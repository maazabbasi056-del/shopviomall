const express = require("express");
const mongoose = require("mongoose");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const { requireAuth, requireDatabase, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireDatabase, requireAuth, requireRole("customer"));

function invalid(message, status = 400) { return Object.assign(new Error(message), { status }); }
function quantityValue(value) {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000) throw invalid("Quantity must be a whole number from 0 to 1000.");
  return quantity;
}

async function transaction(work) {
  const session = await mongoose.startSession();
  let output;
  try { await session.withTransaction(async () => { output = await work(session); }); return output; }
  finally { await session.endSession(); }
}

async function readCart(customerId) {
  const cart = await Cart.findOne({ customerId }).lean();
  const products = cart?.items.length
    ? await Product.find({ _id: { $in: cart.items.map((item) => item.productId) } }).select("title price images stock status category subcategory sellerId").populate("sellerId", "name shopName").lean()
    : [];
  const productById = new Map(products.map((product) => [String(product._id), product]));
  const items = (cart?.items || []).map((item) => {
    const product = productById.get(String(item.productId));
    if (!product) return { productId: String(item.productId), quantity: item.quantity, available: false, product: null };
    const seller = product.sellerId;
    return {
      productId: String(product._id), quantity: item.quantity,
      available: product.status === "active" && product.stock >= item.quantity,
      product: {
        title: product.title, price: product.price, images: product.images || [], stock: product.stock,
        status: product.status, category: product.category,
        seller: seller ? { name: seller.name, shopName: seller.shopName || seller.name } : null
      }
    };
  });
  const subtotal = Math.round(items.reduce((sum, item) => sum + (item.product ? item.product.price * item.quantity : 0), 0) * 100) / 100;
  return { items, subtotal, shippingAmount: 0, total: subtotal, itemCount: items.reduce((sum, item) => sum + item.quantity, 0) };
}

router.get("/", async (req, res, next) => {
  try { res.json({ success: true, cart: await readCart(req.user._id) }); }
  catch (error) { next(error); }
});

router.post("/items", async (req, res, next) => {
  try {
    const { productId } = req.body || {};
    if (!mongoose.isValidObjectId(productId)) throw invalid("Invalid product ID.");
    const amount = quantityValue(req.body?.quantity ?? 1);
    if (!amount) throw invalid("Choose a quantity greater than zero.");
    await transaction(async (session) => {
      const product = await Product.findOne({ _id: productId, status: "active" }).session(session);
      if (!product) throw invalid("Product is not available.", 404);
      let cart = await Cart.findOne({ customerId: req.user._id }).session(session);
      if (!cart) cart = new Cart({ customerId: req.user._id, items: [] });
      const existing = cart.items.find((item) => String(item.productId) === String(product._id));
      const quantity = (existing?.quantity || 0) + amount;
      if (quantity > product.stock) throw invalid("Requested quantity exceeds current available stock.", 409);
      if (existing) existing.quantity = quantity;
      else cart.items.push({ productId: product._id, quantity });
      await cart.save({ session });
    });
    res.status(201).json({ success: true, cart: await readCart(req.user._id) });
  } catch (error) { next(error); }
});

router.patch("/items/:productId", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.productId)) throw invalid("Invalid product ID.");
    const quantity = quantityValue(req.body?.quantity);
    await transaction(async (session) => {
      const cart = await Cart.findOne({ customerId: req.user._id }).session(session);
      if (!cart) throw invalid("Cart item was not found.", 404);
      const item = cart.items.find((entry) => String(entry.productId) === req.params.productId);
      if (!item) throw invalid("Cart item was not found.", 404);
      if (!quantity) { cart.items.pull({ productId: req.params.productId }); await cart.save({ session }); return; }
      const product = await Product.findOne({ _id: req.params.productId, status: "active" }).session(session);
      if (!product) throw invalid("Product is not available.", 404);
      if (quantity > product.stock) throw invalid("Requested quantity exceeds current available stock.", 409);
      item.quantity = quantity;
      await cart.save({ session });
    });
    res.json({ success: true, cart: await readCart(req.user._id) });
  } catch (error) { next(error); }
});

router.delete("/items/:productId", async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID." });
  try {
    await Cart.updateOne({ customerId: req.user._id }, { $pull: { items: { productId: req.params.productId } } });
    res.json({ success: true, cart: await readCart(req.user._id) });
  } catch (error) { next(error); }
});

router.post("/merge", async (req, res, next) => {
  try {
    const incoming = req.body?.items;
    if (!Array.isArray(incoming) || incoming.length > 40) throw invalid("Guest cart must contain no more than forty items.");
    const quantities = new Map();
    for (const entry of incoming) {
      if (!mongoose.isValidObjectId(entry?.productId)) throw invalid("Guest cart contains an invalid product ID.");
      const quantity = quantityValue(entry.quantity);
      if (!quantity) continue;
      const id = String(entry.productId);
      quantities.set(id, (quantities.get(id) || 0) + quantity);
    }
    await transaction(async (session) => {
      const ids = [...quantities.keys()];
      const products = await Product.find({ _id: { $in: ids }, status: "active" }).session(session);
      if (products.length !== ids.length) throw invalid("One or more guest-cart products are no longer available.", 409);
      let cart = await Cart.findOne({ customerId: req.user._id }).session(session);
      if (!cart) cart = new Cart({ customerId: req.user._id, items: [] });
      for (const product of products) {
        const existing = cart.items.find((item) => String(item.productId) === String(product._id));
        const quantity = (existing?.quantity || 0) + quantities.get(String(product._id));
        if (quantity > product.stock) throw invalid("Merged cart quantity exceeds available stock.", 409);
        if (existing) existing.quantity = quantity;
        else cart.items.push({ productId: product._id, quantity });
      }
      await cart.save({ session });
    });
    res.json({ success: true, cart: await readCart(req.user._id) });
  } catch (error) { next(error); }
});

module.exports = router;
