const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { requireAuth, requireDatabase } = require("../middleware/auth");
const JWT_SECRET = require("../config/jwt");

const router = express.Router();

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
      email: user.email || "",
      username: user.username || "",
      role: user.role || "customer",
      accountStatus: user.role === "vendor" ? user.accountStatus : undefined,
      shopName: user.shopName || "",
      shopBio: user.shopBio || "",
      walletAddress: user.walletAddress || ""
    }
  };
}

router.post("/register", requireDatabase, async (req, res) => {
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

    console.error("Registration failed:", error.name || "Error");
    return res.status(500).json({
      success: false,
      message: "Registration failed. Please try again."
    });
  }
});

router.post("/login", requireDatabase, async (req, res) => {
  try {
    const { email, username, identifier, password } = req.body || {};
    const loginIdentifier = typeof identifier === "string" ? identifier.trim() :
      (typeof username === "string" ? username.trim() : (typeof email === "string" ? email.trim() : ""));

    if (!loginIdentifier || typeof password !== "string") {
      return res.status(400).json({
        success: false,
        message: "Email or admin username and password are required."
      });
    }

    const lookup = loginIdentifier.includes("@")
      ? { email: loginIdentifier.toLowerCase() }
      : { username: loginIdentifier.toLowerCase(), role: "admin" };
    const user = await User.findOne(lookup)
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
    console.error("Login failed:", error.name || "Error");
    return res.status(500).json({
      success: false,
      message: "Login failed. Please try again."
    });
  }
});

router.post("/onboard-vendor", requireDatabase, requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "vendor" && req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Seller access is granted only after Admin Central approves your seller application." });
    }
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
    console.error("Vendor onboarding failed:", error.name || "Error");
    return res.status(500).json({
      success: false,
      message: "Store setup failed. Please try again."
    });
  }
});

router.get("/me", requireDatabase, requireAuth, (req, res) => {
  res.json({
    success: true,
    user: {
      id: String(req.user._id),
      name: req.user.name,
      email: req.user.email || "",
      username: req.user.username || "",
      role: req.user.role || "customer",
      shopName: req.user.shopName || "",
      shopBio: req.user.shopBio || "",
      walletAddress: req.user.walletAddress || ""
    }
  });
});

module.exports = router;
