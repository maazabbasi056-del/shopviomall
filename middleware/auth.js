const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");
const JWT_SECRET = require("../config/jwt");

function requireDatabase(_req, res, next) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ success: false, message: "Database is unavailable." });
  }
  next();
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
    if ((user.role === "customer" && user.customerStatus === "suspended") ||
        (user.role === "vendor" && user.accountStatus === "suspended")) {
      return res.status(403).json({ success: false, message: "This account is suspended." });
    }

    req.user = user;
    req.auth = payload;
    return next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Invalid or expired session." });
    }
    return next(error);
  }
}

function requireRole(...allowedRoles) {
  const roles = new Set(allowedRoles.flat());
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    if (!roles.has(req.user.role)) {
      return res.status(403).json({ success: false, message: "This account does not have permission to do that." });
    }
    if (req.user.role === "vendor" && roles.has("vendor") && req.user.accountStatus !== "approved") {
      return res.status(403).json({ success: false, message: "Seller Central is available after Admin Central approves your seller application." });
    }
    return next();
  };
}

function optionalAuth(req, res, next) {
  if (!(req.get("authorization") || "")) return next();
  return requireAuth(req, res, next);
}

module.exports = { requireAuth, requireDatabase, requireRole, optionalAuth };
