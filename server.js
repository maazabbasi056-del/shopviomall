require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("node:path");
const Product = require("./models/Product");
const User = require("./models/User");
const authRoutes = require("./routes/auth");
const productRoutes = require("./routes/products");
const sellerRoutes = require("./routes/seller");
const chatRoutes = require("./routes/chat");
const adminRoutes = require("./routes/admin");
const cartRoutes = require("./routes/cart");
const orderRoutes = require("./routes/orders");
const customerRoutes = require("./routes/customer");
const sellerApplicationRoutes = require("./routes/sellerApplication");
const paymentMethodRoutes = require("./routes/paymentMethods");
const storefrontRoutes = require("./routes/storefronts");
const reviewRoutes = require("./routes/reviews");
const returnRoutes = require("./routes/returns");
const disputeRoutes = require("./routes/disputes");
const refundRoutes = require("./routes/refunds");
const { ensureInitialCategories } = require("./services/categoryCatalog");

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 5000;
const frontendOrigins = new Set((process.env.FRONTEND_ORIGINS || "http://127.0.0.1:5500,http://localhost:5500")
  .split(",").map((origin) => origin.trim()).filter(Boolean));
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
if (publicBaseUrl) {
  try { frontendOrigins.add(new URL(publicBaseUrl).origin); } catch { /* Ignore invalid optional public URL here. */ }
}
const trustedProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS, 10);
if (Number.isInteger(trustedProxyHops) && trustedProxyHops >= 1 && trustedProxyHops <= 5) app.set("trust proxy", trustedProxyHops);

function safeDatabaseError(error) {
  return String(error.message || "Unknown connection error")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, "[redacted MongoDB URI]");
}

function secureHeaders(_req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; font-src 'self' data:"
  });
  next();
}

// Small per-process guard for sensitive write/auth endpoints. Configure a shared
// edge limiter as well if the app is later run on multiple instances.
const rateBuckets = new Map();
function sensitiveRateLimit(req, res, next) {
  const pathname = `${req.baseUrl}${req.path}`;
  const method = req.method;
  let policy = null;
  if (method === "POST" && pathname === "/api/auth/login") policy = [30, 15 * 60 * 1000];
  else if (method === "POST" && /^\/api\/auth\/(register|onboard-vendor)$/.test(pathname)) policy = [12, 15 * 60 * 1000];
  else if (method === "POST" && /^\/api\/seller-application\//.test(pathname)) policy = [10, 15 * 60 * 1000];
  else if (method === "POST" && /^\/api\/chat\//.test(pathname)) policy = [30, 5 * 60 * 1000];
  else if (method === "POST" && /^\/api\/(orders\/checkout|reviews|returns|disputes|refunds|seller\/money-requests)/.test(pathname)) policy = [20, 10 * 60 * 1000];
  if (!policy) return next();

  const now = Date.now();
  const key = `${req.ip || req.socket.remoteAddress || "unknown"}:${pathname}`;
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + policy[1] };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 10000) {
    for (const [bucketKey, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(bucketKey);
  }
  res.set("RateLimit-Limit", String(policy[0]));
  res.set("RateLimit-Remaining", String(Math.max(0, policy[0] - bucket.count)));
  res.set("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
  if (bucket.count > policy[0]) {
    res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    return res.status(429).json({ success: false, message: "Too many requests. Please wait and try again." });
  }
  next();
}

app.disable("x-powered-by");
app.use(secureHeaders);
const corsMiddleware = cors({
  origin(origin, callback) {
    // Requests from a separate frontend must use an explicitly configured origin.
    if (!origin || frontendOrigins.has(origin)) return callback(null, true);
    const error = new Error("Origin is not allowed by CORS.");
    error.status = 403;
    return callback(error);
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-ShopVioMall-Guest", "Idempotency-Key"],
  optionsSuccessStatus: 204
});
app.use((req, res, next) => {
  const origin = req.get("Origin");
  const ownOrigin = `${req.protocol}://${req.get("host")}`;
  // Browsers send Origin on same-origin POST requests too. Those requests do
  // not need CORS headers and must not be rejected by the cross-origin allowlist.
  if (origin && origin === ownOrigin) return next();
  return corsMiddleware(req, res, next);
});
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: false, limit: "32kb", parameterLimit: 50 }));
app.use(sensitiveRateLimit);

// Serve only the public product-media directory. Serving the repository root
// exposed source/config files via static URLs in the previous configuration.
app.use("/uploads/products", express.static(path.join(__dirname, "uploads", "products"), {
  dotfiles: "deny",
  fallthrough: false,
  immutable: true,
  maxAge: process.env.NODE_ENV === "production" ? "7d" : 0,
  index: false
}));

app.get("/api/health", (_req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({
    success: connected,
    status: connected ? "ok" : "unavailable",
    database: connected ? "connected" : "unavailable"
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/seller", sellerRoutes.router);
app.use("/api/admin", adminRoutes);
app.use("/api/admin", sellerRoutes.adminRouter);
app.use("/api/chat", chatRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes.router);
app.use("/api/account", customerRoutes);
app.use("/api/seller-application", sellerApplicationRoutes);
app.use("/api/payment-methods", paymentMethodRoutes);
app.use("/api/shops", storefrontRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/returns", returnRoutes);
app.use("/api/disputes", disputeRoutes);
app.use("/api/refunds", refundRoutes);

app.get("/robots.txt", (_req, res) => {
  const base = publicBaseUrl || `${_req.protocol}://${_req.get("host")}`;
  res.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /account\nSitemap: ${base}/sitemap.xml\n`);
});

app.get("/sitemap.xml", async (req, res, next) => {
  try {
    const base = publicBaseUrl || `${req.protocol}://${req.get("host")}`;
    const [products, shops] = await Promise.all([
      Product.find({ status: "active" }).select("_id updatedAt").sort({ updatedAt: -1 }).limit(2000).lean(),
      User.find({ role: "vendor", accountStatus: "approved", shopSlug: { $type: "string", $ne: "" } }).select("shopSlug updatedAt").sort({ updatedAt: -1 }).limit(500).lean()
    ]);
    const informationRoutes = ["about", "contact", "terms", "privacy", "seller-terms", "returns-policy", "buyer-support", "prohibited-items"];
    const urls = [base, ...informationRoutes.map((route) => `${base}/${route}`), ...products.map((item) => `${base}/product/${item._id}`), ...shops.map((item) => `${base}/shop/${encodeURIComponent(item.shopSlug)}`)];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${url.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</loc></url>`).join("")}</urlset>`;
    res.type("application/xml").send(xml);
  } catch (error) { next(error); }
});

const appShellRoutes = [
  "/", "/admin", "/about", "/contact", "/terms", "/privacy", "/seller-terms",
  "/returns-policy", "/buyer-support", "/prohibited-items", "/product/:productId",
  "/category/:categorySlug", "/shop/:shopSlug"
];
app.get(appShellRoutes, (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ success: false, message: "Endpoint not found." });
  return res.status(404).sendFile(path.join(__dirname, "index.html"));
});

app.use((error, req, res, _next) => {
  if (res.headersSent) return;
  if (error.status === 404 && req.path.startsWith("/uploads/products/")) return res.status(404).json({ success: false, message: "File not found." });
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  if (status >= 500) console.error("Request failed:", error.name || "Error");
  res.status(status).json({ success: false, message: status < 500 ? error.message : "An unexpected server error occurred." });
});

mongoose.connection.on("connected", () => console.log("MongoDB connected."));
mongoose.connection.on("disconnected", () => console.error("MongoDB disconnected."));
mongoose.connection.on("error", (error) => console.error("MongoDB connection error:", safeDatabaseError(error)));

async function start() {
  if (!process.env.MONGODB_URI) {
    console.error("MongoDB connection failed: MONGODB_URI is not configured.");
  } else {
    try {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
      await ensureInitialCategories();
    } catch (error) {
      console.error("MongoDB connection failed:", safeDatabaseError(error));
    }
  }
  app.listen(PORT, () => console.log(`ShopVioMall server listening on port ${PORT}.`));
}

if (require.main === module) start();
module.exports = { app, start };
