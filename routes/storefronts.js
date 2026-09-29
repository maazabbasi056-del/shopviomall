const express = require("express");
const Product = require("../models/Product");
const User = require("../models/User");
const ProductReview = require("../models/ProductReview");
const { getCategory, listCategories } = require("../services/categoryCatalog");
const { requireDatabase } = require("../middleware/auth");
const router = express.Router(); router.use(requireDatabase);
router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, Math.min(Number.parseInt(req.query.page, 10) || 1, 10000));
    const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 12, 30));
    const shops = await User.find({ role: "vendor", accountStatus: "approved", kycStatus: "approved", shopSlug: { $type: "string", $gt: "" } })
      .select("name shopName shopSlug shopBio shopImageUrl createdAt").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    const ids = shops.map(shop => shop._id);
    const [counts, ratings, total] = await Promise.all([
      Product.aggregate([{ $match: { sellerId: { $in: ids }, status: "active" } }, { $group: { _id: "$sellerId", count: { $sum: 1 } } }]),
      ProductReview.aggregate([{ $match: { sellerId: { $in: ids }, status: "published" } }, { $group: { _id: "$sellerId", average: { $avg: "$rating" }, count: { $sum: 1 } } }]),
      User.countDocuments({ role: "vendor", accountStatus: "approved", kycStatus: "approved", shopSlug: { $type: "string", $gt: "" } })
    ]);
    const countMap = new Map(counts.map(row => [String(row._id), row.count]));
    const ratingMap = new Map(ratings.map(row => [String(row._id), { average: Math.round(row.average * 100) / 100, count: row.count }]));
    res.json({ success: true, shops: shops.map(shop => ({ ...shop, activeProductCount: countMap.get(String(shop._id)) || 0, rating: ratingMap.get(String(shop._id)) || { average: 0, count: 0 } })).filter(shop => shop.activeProductCount), total, page, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
});
router.get("/:shopSlug", async (req, res, next) => {
  const shopSlug = String(req.params.shopSlug || "").toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shopSlug)) return res.status(400).json({ success: false, message: "Invalid shop URL." });
  try {
    const seller = await User.findOne({ shopSlug, role: "vendor", accountStatus: "approved", kycStatus: "approved" }).select("name shopName shopSlug shopBio shopImageUrl createdAt").lean();
    if (!seller) return res.status(404).json({ success: false, message: "Approved shop not found." });
    const page = Math.max(1, Math.min(Number.parseInt(req.query.page, 10) || 1, 10000)), limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 24, 60));
    const filter = { sellerId: seller._id, status: "active" };
    const category = req.query.category ? await getCategory(String(req.query.category)) : null;
    if (req.query.category && !category) return res.status(400).json({ success: false, message: "Unknown category." });
    if (category) filter.category = category.name;
    if (req.query.subcategory) {
      const subcategory = String(req.query.subcategory).trim().slice(0, 100);
      const matchingCategory = category || (await listCategories()).find(item => item.subcategories.includes(subcategory));
      if (!matchingCategory?.subcategories.includes(subcategory)) return res.status(400).json({ success: false, message: "Unknown subcategory." });
      filter.subcategory = subcategory;
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
    if (q) filter.$or = [{ title: new RegExp(q, "i") }, { description: new RegExp(q, "i") }, { brand: new RegExp(q, "i") }];
    const sort = { newest: { createdAt: -1 }, "price-asc": { price: 1, createdAt: -1 }, "price-desc": { price: -1, createdAt: -1 }, popular: { views: -1, createdAt: -1 } }[req.query.sort] || { createdAt: -1 };
    const [products, total, categoryRows, ratings] = await Promise.all([
      Product.find(filter).select("title description price originalPrice category subcategory brand condition images stock views createdAt").sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      Product.countDocuments(filter),
      Product.aggregate([{ $match: { sellerId: seller._id, status: "active" } }, { $group: { _id: "$category", count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      ProductReview.aggregate([{ $match: { sellerId: seller._id, status: "published" } }, { $group: { _id: null, average: { $avg: "$rating" }, count: { $sum: 1 } } }])
    ]);
    res.json({ success: true, shop: seller, products, total, page, pages: Math.ceil(total / limit), categories: categoryRows.map(row => ({ name: row._id, count: row.count })), rating: ratings[0] ? { average: Math.round(ratings[0].average * 100) / 100, count: ratings[0].count } : { average: 0, count: 0 } });
  } catch (error) { next(error); }
});
module.exports = router;
