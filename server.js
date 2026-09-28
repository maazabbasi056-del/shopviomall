require("dotenv").config();

const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");

const app = express();
const PORT = 5000;
const users = [];

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(__dirname));

function makeSession(user) {
  res.json({
    success: true,
    token: crypto.randomBytes(24).toString("hex"),
    user: { id: user.id, name: user.name, email: user.email }
  });
}

app.post("/api/auth/register", (req, res) => {
  const email = String(req.body?.email || "demo@shopviomall.local").trim();
  const user = {
    id: crypto.randomUUID(),
    name: String(req.body?.name || "ShopVioMall Customer").trim(),
    email
  };

  users.push(user);
  res.json({
    success: true,
    token: crypto.randomBytes(24).toString("hex"),
    user
  });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body?.email || "demo@shopviomall.local").trim();
  const user = users.find((item) => item.email.toLowerCase() === email.toLowerCase()) || {
    id: crypto.randomUUID(),
    name: "ShopVioMall Customer",
    email
  };

  res.json({
    success: true,
    token: crypto.randomBytes(24).toString("hex"),
    user
  });
});

app.post("/api/products/upload", (req, res) => {
  res.json({
    success: true,
    message: "Mock product upload completed.",
    product: {
      id: crypto.randomUUID(),
      name: String(req.body?.name || "Demo product"),
      createdAt: new Date().toISOString()
    }
  });
});

app.post("/api/auth/onboard-vendor", (req, res) => {
  res.json({
    success: true,
    message: "Mock seller profile saved.",
    shopName: String(req.body?.shopName || "")
  });
});

app.get("/api/products", (_req, res) => {
  res.json({ success: true, products: [] });
});

app.get("/api/health", (_req, res) => {
  res.json({ success: true, status: "ok" });
});

app.listen(PORT, () => {
  console.log(`ShopVioMall server listening at http://localhost:${PORT}`);
});