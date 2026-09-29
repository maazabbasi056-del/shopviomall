const express = require("express");
const mongoose = require("mongoose");
const Product = require("../models/Product");
const { requireAuth, requireDatabase, requireRole } = require("../middleware/auth");
const { listCategories, getCategory } = require("../services/categoryCatalog");
const ProductReview = require("../models/ProductReview");
const User = require("../models/User");
const { normalizeProductInput, removeFiles } = require("../services/productInput");

const router = express.Router();

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listActiveProducts(req, res, next) {
  try {
    const filter = { status: "active" };
    if (req.query.category) {
      if (!await getCategory(req.query.category)) {
        return res.status(400).json({ success: false, message: "Unknown category." });
      }
      filter.category = req.query.category;
    }
    if (req.query.subcategory) {
      const subcategory = String(req.query.subcategory).trim().slice(0, 120);
      const categoryRows = req.query.category ? [await getCategory(req.query.category)].filter(Boolean) : await listCategories();
      const valid = categoryRows.some(category => category.subcategories.includes(subcategory));
      if (!valid) return res.status(400).json({ success: false, message: "Unknown subcategory." });
      filter.subcategory = subcategory;
    }
    const minPrice = req.query.minPrice === undefined ? undefined : Number(req.query.minPrice);
    const maxPrice = req.query.maxPrice === undefined ? undefined : Number(req.query.maxPrice);
    if ((minPrice !== undefined && (!Number.isFinite(minPrice) || minPrice < 0)) || (maxPrice !== undefined && (!Number.isFinite(maxPrice) || maxPrice < 0)) || (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice)) return res.status(400).json({ success: false, message: "Price range is invalid." });
    if (minPrice !== undefined || maxPrice !== undefined) filter.price = { ...(minPrice !== undefined ? { $gte: minPrice } : {}), ...(maxPrice !== undefined ? { $lte: maxPrice } : {}) };
    if (req.query.inStock === "true") filter.stock = { $gt: 0 };
    if (req.query.deals === "true") filter.$expr = { $gt: ["$originalPrice", "$price"] };
    if (typeof req.query.brand === "string" && req.query.brand.trim()) filter.brand = new RegExp(escapeRegex(req.query.brand.trim().slice(0, 80)), "i");
    if (typeof req.query.shop === "string" && req.query.shop.trim()) {
      const seller = await User.findOne({ shopSlug: req.query.shop.trim().toLowerCase(), role: "vendor", accountStatus: "approved", kycStatus: "approved" }).select("_id").lean();
      if (!seller) return res.json({ success: true, products: [], total: 0, page: 1, pages: 0 });
      filter.sellerId = seller._id;
    } else if (typeof req.query.sellerId === "string") {
      if (!mongoose.isValidObjectId(req.query.sellerId)) return res.status(400).json({ success: false, message: "Seller filter is invalid." });
      filter.sellerId = req.query.sellerId;
    }
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    if (query) {
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const matchingSellerIds = await User.find({ role: "vendor", accountStatus: "approved", kycStatus: "approved", $or: [{ shopName: pattern }, { name: pattern }] }).distinct("_id");
      filter.$or = [{ title: pattern }, { description: pattern }, { detailedDescription: pattern }, { category: pattern }, { subcategory: pattern }, { brand: pattern }, ...(matchingSellerIds.length ? [{ sellerId: { $in: matchingSellerIds } }] : [])];
    }

    const sortKey = req.query.sort || (query ? "relevance" : "newest");
    const sort = {
      relevance: { createdAt: -1 },
      newest: { createdAt: -1 },
      "price-asc": { price: 1, createdAt: -1 },
      "price-desc": { price: -1, createdAt: -1 },
      popular: { views: -1, createdAt: -1 },
      rating: { createdAt: -1 }
    }[sortKey];
    if (!sort) return res.status(400).json({ success: false, message: "Unknown sort option." });

    const page = Math.max(1, Math.min(Number.parseInt(req.query.page, 10) || 1, 100000));
    const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 48, 60));
    const ratingFloor = req.query.minRating === undefined ? undefined : Number(req.query.minRating);
    if (ratingFloor !== undefined && (!Number.isFinite(ratingFloor) || ratingFloor < 0 || ratingFloor > 5)) return res.status(400).json({ success: false, message: "Rating filter must be between zero and five." });
    if (ratingFloor !== undefined && ratingFloor > 0) {
      const ratedIds = await ProductReview.aggregate([{ $match: { status: "published" } }, { $group: { _id: "$productId", average: { $avg: "$rating" } } }, { $match: { average: { $gte: ratingFloor } } }]);
      filter._id = { $in: ratedIds.map(row => row._id) };
    }
    const approvedSellers = await User.find({ role: "vendor", accountStatus: "approved", kycStatus: "approved" }).distinct("_id");
    if (filter.sellerId) {
      const sellerIds = Array.isArray(filter.sellerId.$in) ? filter.sellerId.$in : [filter.sellerId];
      filter.sellerId = { $in: approvedSellers.filter(id => sellerIds.some(candidate => String(candidate) === String(id))) };
    } else filter.sellerId = { $in: approvedSellers };

    const productQuery = Product.find(filter)
      .select("title description detailedDescription specifications brand condition price originalPrice category subcategory sellerId images stock sku status views createdAt updatedAt")
      .populate({ path: "sellerId", select: "name shopName shopBio shopSlug", match: { role: "vendor", accountStatus: "approved", kycStatus: "approved" } })
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
    const rankedQuery = sortKey === "relevance" && query;
    const ratingQuery = sortKey === "rating";
    const productsPromise = rankedQuery
      ? Product.aggregate([
        { $match: filter },
        { $addFields: { _relevance: { $add: [
          { $cond: [{ $regexMatch: { input: "$title", regex: `^${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, options: "i" } }, 4, 0] },
          { $cond: [{ $regexMatch: { input: "$title", regex: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options: "i" } }, 3, 0] },
          { $cond: [{ $regexMatch: { input: { $ifNull: ["$brand", ""] }, regex: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options: "i" } }, 2, 0] },
          { $cond: [{ $regexMatch: { input: { $ifNull: ["$subcategory", ""] }, regex: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options: "i" } }, 1, 0] }
        ] } } },
        { $sort: { _relevance: -1, createdAt: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }, { $project: { _relevance: 0 } }
      ]).then(rows => Product.populate(rows, { path: "sellerId", select: "name shopName shopBio shopSlug", match: { role: "vendor", accountStatus: "approved", kycStatus: "approved" } }))
      : ratingQuery
        ? Product.aggregate([
          { $match: filter },
          { $lookup: { from: ProductReview.collection.name, let: { productId: "$_id" }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$productId", "$$productId"] }, { $eq: ["$status", "published"] }] } } }, { $group: { _id: null, average: { $avg: "$rating" }, count: { $sum: 1 } } }], as: "_rating" } },
          { $addFields: { _rating: { $ifNull: [{ $first: "$_rating" }, { average: 0, count: 0 }] } } },
          { $sort: { "_rating.average": -1, "_rating.count": -1, createdAt: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }, { $project: { _rating: 0 } }
        ]).then(rows => Product.populate(rows, { path: "sellerId", select: "name shopName shopBio shopSlug", match: { role: "vendor", accountStatus: "approved", kycStatus: "approved" } }))
        : productQuery;
    const [products, total] = await Promise.all([
      productsPromise,
      Product.countDocuments(filter)
    ]);
    const ids = products.map(product => product._id);
    const stats = ids.length ? await ProductReview.aggregate([{ $match: { productId: { $in: ids }, status: "published" } }, { $group: { _id: "$productId", average: { $avg: "$rating" }, count: { $sum: 1 } } }]) : [];
    const statMap = new Map(stats.map(item => [String(item._id), { average: Math.round(item.average * 100) / 100, count: item.count }]));
    return res.json({ success: true, products: products.filter(product => product.sellerId).map(product => ({ ...product, rating: statMap.get(String(product._id)) || { average: 0, count: 0 } })), total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    return next(error);
  }
}

router.get("/all", requireDatabase, listActiveProducts);
router.get("/", requireDatabase, listActiveProducts);
router.get("/categories", requireDatabase, async (_req, res, next) => { try { const rows = await listCategories(); res.json({ success: true, categories: rows.map(category => ({ name: category.name, slug: category.slug, subcategories: category.subcategories })) }); } catch (error) { next(error); } });

// Compatibility for the earlier product-upload endpoint, now database-backed and vendor-owned.
router.post("/upload", requireDatabase, requireAuth, requireRole("vendor"), async (req, res, next) => {
  let savedFiles = [];
  try {
    const parsed = await normalizeProductInput(req.body);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    savedFiles = parsed.savedFiles;
    const product = await Product.create({ ...parsed.fields, sellerId: req.user._id });
    return res.status(201).json({ success: true, product });
  } catch (error) {
    await removeFiles(savedFiles);
    if (error.name === "ValidationError") return res.status(400).json({ success: false, message: error.message });
    if (error.code === 11000) return res.status(409).json({ success: false, message: "That SKU is already used by one of your products." });
    if (/^Images? |^A product can|^Invalid image|^An image is|^Product images/i.test(error.message || "")) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return next(error);
  }
});

router.get("/:productId", requireDatabase, async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.productId)) {
    return res.status(400).json({ success: false, message: "Invalid product ID." });
  }
  try {
    const eligibleSellerIds = await User.find({ role: "vendor", accountStatus: "approved", kycStatus: "approved" }).distinct("_id");
    const product = await Product.findOneAndUpdate({ _id: req.params.productId, status: "active", sellerId: { $in: eligibleSellerIds } }, { $inc: { views: 1 } }, { returnDocument: "after" })
      .select("title description detailedDescription specifications brand condition price originalPrice category subcategory sellerId images stock sku status views createdAt updatedAt")
      .populate("sellerId", "name shopName shopBio shopSlug")
      .lean();
    if (!product) return res.status(404).json({ success: false, message: "Product not found." });
    const [rating] = await ProductReview.aggregate([{ $match: { productId: product._id, status: "published" } }, { $group: { _id: null, average: { $avg: "$rating" }, count: { $sum: 1 }, ratings: { $push: "$rating" } } }]);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; for (const value of rating?.ratings || []) distribution[value]++;
    const relatedFilter = { status: "active", sellerId: { $in: eligibleSellerIds }, _id: { $ne: product._id } };
    const [relatedRaw, sellerRaw] = await Promise.all([
      Product.find({ ...relatedFilter, category: product.category }).select("title price originalPrice images stock category subcategory sellerId createdAt").populate("sellerId", "name shopName shopSlug").sort({ createdAt: -1 }).limit(4).lean(),
      Product.find({ ...relatedFilter, sellerId: product.sellerId._id || product.sellerId }).select("title price originalPrice images stock category subcategory sellerId createdAt").populate("sellerId", "name shopName shopSlug").sort({ createdAt: -1 }).limit(4).lean()
    ]);
    const recommendationIds = [...new Set([...relatedRaw, ...sellerRaw].map(item => String(item._id)))].map(id => new mongoose.Types.ObjectId(id));
    const recommendationRatings = recommendationIds.length ? await ProductReview.aggregate([{ $match: { productId: { $in: recommendationIds }, status: "published" } }, { $group: { _id: "$productId", average: { $avg: "$rating" }, count: { $sum: 1 } } }]) : [];
    const recommendationMap = new Map(recommendationRatings.map(row => [String(row._id), { average: Math.round(row.average * 100) / 100, count: row.count }]));
    const rateRows = rows => rows.map(item => ({ ...item, rating: recommendationMap.get(String(item._id)) || { average: 0, count: 0 } }));
    const publicProduct = { ...product, rating: rating ? { average: Math.round(rating.average * 100) / 100, count: rating.count, distribution } : { average: 0, count: 0, distribution } };
    return res.json({ success: true, product: publicProduct, related: rateRows(relatedRaw), moreFromSeller: rateRows(sellerRaw) });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
