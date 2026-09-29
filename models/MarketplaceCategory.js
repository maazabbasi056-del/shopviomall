const mongoose = require("mongoose");

const marketplaceCategorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
  subcategories: [{ type: String, trim: true, minlength: 1, maxlength: 100 }],
  status: { type: String, enum: ["active", "archived"], default: "active", index: true },
  seededFromConfig: { type: Boolean, default: false, immutable: true }
}, { timestamps: true });

marketplaceCategorySchema.index({ name: 1 }, { unique: true });
marketplaceCategorySchema.index({ slug: 1 }, { unique: true });
module.exports = mongoose.models.MarketplaceCategory || mongoose.model("MarketplaceCategory", marketplaceCategorySchema);
