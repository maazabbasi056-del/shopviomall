const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, minlength: 2, maxlength: 160 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    price: { type: Number, required: true, min: 0 },
    category: {
      type: String,
      required: true,
      trim: true,
      enum: ["Accounts", "Software", "Services"]
    },
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    status: { type: String, enum: ["active", "draft", "archived"], default: "active" }
  },
  { timestamps: true }
);

productSchema.index({ status: 1, category: 1, createdAt: -1 });

module.exports = mongoose.models.Product || mongoose.model("Product", productSchema);