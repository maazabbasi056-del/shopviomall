const mongoose = require("mongoose");

const cartItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  quantity: { type: Number, required: true, min: 1, validate: Number.isInteger }
}, { _id: false });

const cartSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  items: { type: [cartItemSchema], default: [] }
}, { timestamps: true });

module.exports = mongoose.models.Cart || mongoose.model("Cart", cartSchema);
