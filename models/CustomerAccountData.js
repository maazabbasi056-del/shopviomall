const mongoose = require("mongoose");

const addressSchema = new mongoose.Schema({
  label: { type: String, trim: true, maxlength: 40, default: "Shipping" },
  recipient: { type: String, required: true, trim: true, maxlength: 120 },
  line1: { type: String, required: true, trim: true, maxlength: 200 },
  line2: { type: String, trim: true, maxlength: 200, default: "" },
  city: { type: String, required: true, trim: true, maxlength: 100 },
  region: { type: String, trim: true, maxlength: 100, default: "" },
  postalCode: { type: String, trim: true, maxlength: 32, default: "" },
  country: { type: String, required: true, trim: true, maxlength: 100 },
  isDefault: { type: Boolean, default: false }
}, { _id: true });

const customerAccountDataSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  addresses: { type: [addressSchema], default: [] },
  wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
  firstName: { type: String, trim: true, maxlength: 60, default: "" },
  lastName: { type: String, trim: true, maxlength: 60, default: "" },
  phone: { type: String, trim: true, maxlength: 40, default: "" }
}, { timestamps: true });

module.exports = mongoose.models.CustomerAccountData || mongoose.model("CustomerAccountData", customerAccountDataSchema);
