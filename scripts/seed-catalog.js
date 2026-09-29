require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("../models/Product");
const User = require("../models/User");
const MarketplaceCategory = require("../models/MarketplaceCategory");

const PREFIX = "shopviomall-dev-catalog-v1-";
const entries = [
  ["Everyday canvas tote", "A lightweight carryall for errands, books, and daily essentials.", "Women Clothing & Fashion", "Accessories", "Northline", 18.5, 24],
  ["Cotton weekend shirt", "A comfortable woven shirt with a relaxed everyday fit.", "Men Clothing & Fashion", "Shirts & Polos", "Field & Form", 29, 36],
  ["Adjustable laptop stand", "A foldable aluminum stand designed to raise a laptop on a desk.", "Computer & Accessories", "Laptops", "Deskline", 34, 42],
  ["Braided USB charging cable", "A durable braided cable for compatible USB-C devices.", "Phone & Phone Accessories", "Chargers & Cables", "Northline", 9.5, 12],
  ["Wooden shape puzzle", "A colorful wooden matching puzzle for supervised play.", "Kids & Toys", "Educational Toys", "Little Grove", 16, 20],
  ["Resistance band set", "A compact set of exercise bands with varied resistance levels.", "Sports & Outdoor", "Fitness Equipment", "Trailmark", 21, 28],
  ["Compact tire repair kit", "A portable set of basic bicycle tire repair tools.", "Automobile & Motorcycle", "Care & Tools", "Trailmark", 14, 18],
  ["Minimal dial wristwatch", "A simple analog watch with a clean, easy-to-read dial.", "Jewelry & Watches", "Watches", "Timewell", 48, 60],
  ["Precision screwdriver set", "A compact driver set for common small household repairs.", "Home Improvement & Tools", "Hand Tools", "Workshop Basic", 19, 25],
  ["Linen cushion cover", "A textured cushion cover for refreshing a living space.", "Home Decoration", "Living Room", "Hearthside", 22, 29],
  ["Gentle daily shampoo", "A mild everyday shampoo for routine hair washing.", "Beauty & Personal Care", "Haircare", "Kindred Care", 12, 15],
  ["Reusable glass food jars", "A set of reusable lidded jars for pantry organization.", "Groceries & Pet Supplies", "Household", "Hearthside", 17, 22],
  ["Carry-on packing cubes", "A lightweight organizer set for separating travel essentials.", "Luggage & Travel Gear", "Organizers", "Wayfarer", 26, 33],
  ["Desk cable organizer", "A small desktop organizer that keeps charging cables within reach.", "Office Electronics & Furniture", "Desk Accessories", "Deskline", 11, 14],
  ["Portable reading light", "A rechargeable clip-on light with adjustable brightness.", "Consumer Electronics", "Accessories", "Brightpath", 24, 31],
  ["Printed cotton scarf", "A soft lightweight scarf with a simple geometric print.", "Women Clothing & Fashion", "Accessories", "Field & Form", 20, 26],
  ["Insulated travel mug", "A reusable travel mug with a secure screw lid.", "Home Decoration", "Living Room", "Wayfarer", 23, 30],
  ["Compact mouse pad", "A smooth, easy-clean mouse surface for a home or office desk.", "Computer & Accessories", "Keyboards & Mice", "Deskline", 8, 11],
  ["Soft pet grooming brush", "A washable grooming brush for routine coat care.", "Groceries & Pet Supplies", "Pet Care", "Kindred Care", 13, 17],
  ["Weekend trail bottle", "A reusable lightweight bottle for day trips and outdoor use.", "Sports & Outdoor", "Camping", "Trailmark", 15, 19]
];

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured.");
  await mongoose.connect(process.env.MONGODB_URI);
  if (process.argv.includes("--cleanup")) {
    const result = await Product.deleteMany({ developmentSeedKey: new RegExp(`^${PREFIX}`) });
    console.log(`Removed ${result.deletedCount} development catalog products.`);
    return;
  }
  const sellers = await User.find({ role: "vendor", accountStatus: "approved", kycStatus: "approved" }).select("_id").sort({ createdAt: 1 }).limit(1).lean();
  if (!sellers.length) throw new Error("No approved seller is available. Approve a seller before seeding public listings.");
  const sellerId = sellers[0]._id;
  const categoryNames = [...new Set(entries.map((entry) => entry[2]))];
  const categories = await MarketplaceCategory.find({ name: { $in: categoryNames }, status: "active" }).select("name subcategories").lean();
  const categoryByName = new Map(categories.map((category) => [category.name, category]));
  const existingKeys = new Set((await Product.find({ developmentSeedKey: { $in: entries.map((_, i) => `${PREFIX}${String(i + 1).padStart(2, "0")}`) } }).select("+developmentSeedKey").lean()).map((product) => product.developmentSeedKey));
  const operations = [];
  for (let i = 0; i < entries.length; i++) {
    const [title, description, category, subcategory, brand, price, originalPrice] = entries[i];
    const categoryRecord = categoryByName.get(category);
    if (!categoryRecord?.subcategories.includes(subcategory)) throw new Error(`Seed category mismatch: ${category} / ${subcategory}`);
    const key = `${PREFIX}${String(i + 1).padStart(2, "0")}`;
    if (existingKeys.has(key)) continue;
    operations.push({ updateOne: { filter: { developmentSeedKey: key }, update: { $setOnInsert: {
      developmentSeedKey: key, sellerId, title, description, detailedDescription: description,
      category, subcategory, brand, condition: "new", price, originalPrice,
      baseCost: Math.round(price * 0.55 * 100) / 100, commissionRate: 5, stock: 12,
      images: [], sku: key.toUpperCase(), status: "active", specifications: []
    } }, upsert: true } });
  }
  if (operations.length) await Product.bulkWrite(operations, { ordered: false });
  const readyCount = await Product.countDocuments({ developmentSeedKey: { $in: entries.map((_, i) => `${PREFIX}${String(i + 1).padStart(2, "0")}`) } });
  if (readyCount !== entries.length) throw new Error("Catalog seed did not create all expected products.");
  console.log(`Catalog seed is ready: ${entries.length} identifiable development products. Repeat safely with npm run seed:catalog; remove only these tagged records with npm run seed:catalog:clean.`);
}

main().catch(error => { console.error(`Catalog seed failed: ${error.message}`); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect().catch(() => {}); });
