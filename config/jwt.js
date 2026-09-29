const crypto = require("node:crypto");

const jwtSecret = process.env.JWT_SECRET || (
  process.env.NODE_ENV === "production"
    ? null
    : crypto.randomBytes(32).toString("hex")
);

if (!jwtSecret) {
  throw new Error("JWT_SECRET must be configured in production.");
}

if (!process.env.JWT_SECRET && process.env.NODE_ENV !== "production") {
  console.warn("JWT_SECRET is unset; using an ephemeral development-only secret.");
}

module.exports = jwtSecret;
