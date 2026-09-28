const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Product = require("../models/Product");

const router = express.Router();

function requireDatabase(_req, res, next) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ success: false, message: "Database is unavailable." });
  }
  next();
}

function requireUser(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    return res.status(401).json({ success: false, message: "Authentication required." });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload.sub || !mongoose.isValidObjectId(payload.sub)) {
      return res.status(401).json({ success: false, message: "Invalid session." });
    }
    req.auth = payload;
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired session." });
  }
}

function present(product) {
  const item = product.toObject ? product.toObject() : product;
  return { ...item, name: item.title };
}

// GET /api/products/all
router.get("/all", requireDatabase, async (_req, res, next) => {
  try {
    const products = await Product.find({ status: "active" })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      products: products.map((product) => ({ ...product, name: product.title }))
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/products/upload
router.post("/upload", requireUser, requireDatabase, async (req, res, next) => {
  try {
    const { title, description, price, category } = req.body || {};
    const numericPrice = Number(price);

    if (
      typeof title !== "string" || !title.trim() ||
      typeof description !== "string" || !description.trim() ||
      !Number.isFinite(numericPrice) || numericPrice < 0 ||
      !["Accounts", "Software", "Services"].includes(category)
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid title, description, non-negative price, and category are required."
      });
    }

    const product = await Product.create({
      title: title.trim(),
      description: description.trim(),
      price: numericPrice,
      category,
      sellerId: req.auth.sub
    });

    return res.status(201).json({ success: true, product: present(product) });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
});

// Compatibility endpoint for clients using GET /api/products.
router.get("/", requireDatabase, async (_req, res, next) => {
  try {
    const products = await Product.find({ status: "active" })
      .sort({ createdAt: -1 })
      .lean();
    res.json({
      success: true,
      products: products.map((product) => ({ ...product, name: product.title }))
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;