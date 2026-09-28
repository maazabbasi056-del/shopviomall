const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");

const router = express.Router();

const JWT_SECRET =
  process.env.JWT_SECRET ||
  (process.env.NODE_ENV === "production" ? null : "shopviomall_secret_key");

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET must be configured in production.");
}

function createSessionToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role || "customer" },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

function authResponse(user, token) {
  return {
    success: true,
    token,
    user: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role || "customer",
      shopName: user.shopName || "",
      shopBio: user.shopBio || "",
      walletAddress: user.walletAddress || ""
    }
  };
}

async function requireAuth(req, res, next) {
  const authorization = req.get("authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!token) {
    return res.status(401).json({ success: false, message: "Authentication required." });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.sub || !mongoose.isValidObjectId(payload.sub)) {
      return res.status(401).json({ success: false, message: "Invalid session." });
    }

    const user = await User.findById(payload.sub).select("-password");
    if (!user) {
      return res.status(401).json({ success: false, message: "Account not found." });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Invalid or expired session." });
    }
    next(error);
  }
}

router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (
      typeof name !== "string" || !name.trim() ||
      typeof email !== "string" || !email.trim() ||
      typeof password !== "string" || password.length < 8
    ) {
      return res.status(400).json({
        success: false,
        message: "Name, email, and a password of at least 8 characters are required."
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await User.findOne({ email: normalizedEmail });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "An account with that email already exists."
      });
    }

    // Pass plaintext here when the User model hashes passwords in its save hook.
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password,
      role: "customer"
    });

    return res.status(201).json(authResponse(user, createSessionToken(user)));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "An account with that email already exists."
      });
    }

    console.error("Registration error:", error);
    return res.status(500).json({
      success: false,
      message: "Registration failed. Please try again."
    });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({
        success: false,
        message: "Email and password are required."
      });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() })
      .select("+password");

    if (!user || typeof user.password !== "string" ||
        !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    return res.json(authResponse(user, createSessionToken(user)));
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      success: false,
      message: "Login failed. Please try again."
    });
  }
});

router.post("/onboard-vendor", requireAuth, async (req, res) => {
  try {
    const { shopName, shopBio, walletAddress = "" } = req.body || {};

    if (
      typeof shopName !== "string" || !shopName.trim() ||
      typeof shopBio !== "string" || !shopBio.trim() ||
      typeof walletAddress !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Store name and description are required."
      });
    }

    req.user.shopName = shopName.trim();
    req.user.shopBio = shopBio.trim();
    req.user.walletAddress = walletAddress.trim();
    if (req.user.role !== "admin") req.user.role = "vendor";

    await req.user.save();

    return res.json({
      success: true,
      user: {
        id: String(req.user._id),
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        shopName: req.user.shopName || "",
        shopBio: req.user.shopBio || "",
        walletAddress: req.user.walletAddress || ""
      }
    });
  } catch (error) {
    console.error("Vendor onboarding error:", error);
    return res.status(500).json({
      success: false,
      message: "Store setup failed. Please try again."
    });
  }
});

router.get("/me", requireAuth, (req, res) => {
  res.json({
    success: true,
    user: {
      id: String(req.user._id),
      name: req.user.name,
      email: req.user.email,
      role: req.user.role || "customer",
      shopName: req.user.shopName || "",
      shopBio: req.user.shopBio || "",
      walletAddress: req.user.walletAddress || ""
    }
  });
});

module.exports = router;
