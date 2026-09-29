const mongoose = require("mongoose");
const MarketplaceCategory = require("./MarketplaceCategory");

const productSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, minlength: 2, maxlength: 160 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    detailedDescription: { type: String, default: "", trim: true, maxlength: 15000 },
    specifications: [{ name: { type: String, trim: true, maxlength: 80 }, value: { type: String, trim: true, maxlength: 500 } }],
    brand: { type: String, default: "", trim: true, maxlength: 100 },
    condition: { type: String, enum: ["new", "used", "refurbished", ""], default: "new" },
    price: { type: Number, required: true, min: 0 },
    originalPrice: { type: Number, min: 0 },
    baseCost: { type: Number, min: 0, default: 0 },
    commissionRate: { type: Number, min: 0, max: 50, default: 5 },
    category: { type: String, required: true, trim: true, maxlength: 100, validate: { validator: async value => Boolean(await MarketplaceCategory.exists({ name: value })), message: "Product category is not available." } },
    subcategory: {
      type: String,
      default: "",
      validate: {
        validator: async function (value) { return !value || Boolean(await MarketplaceCategory.exists({ name: this.category, subcategories: value })); },
        message: "Subcategory must belong to the selected category."
      }
    },
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    images: [{ type: String, maxlength: 2048 }],
    stock: { type: Number, required: true, min: 0, default: 0, validate: Number.isInteger },
    sku: { type: String, trim: true, maxlength: 80, default: "" },
    status: { type: String, enum: ["draft", "active", "archived"], default: "draft", index: true },
    views: { type: Number, default: 0, min: 0 },
    developmentSeedKey: { type: String, default: undefined, select: false },
    moderationHistory: [{ status: { type: String, enum: ["draft", "active", "archived"] }, reason: { type: String, maxlength: 1000 }, adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, at: { type: Date, default: Date.now } }]
  },
  { timestamps: true }
);

productSchema.index({ status: 1, category: 1, createdAt: -1 });
productSchema.index({ sellerId: 1, status: 1, createdAt: -1 });
productSchema.index({ title: "text", description: "text", detailedDescription: "text", subcategory: "text" });
productSchema.index({ sellerId: 1, sku: 1 }, { unique: true, partialFilterExpression: { sku: { $type: "string", $gt: "" } } });
productSchema.index({ developmentSeedKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.Product || mongoose.model("Product", productSchema);
