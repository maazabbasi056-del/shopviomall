require("dotenv").config();

const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { chromium } = require("playwright");
const axeSource = require("axe-core").source;
const User = require("../models/User");
const Product = require("../models/Product");
const Order = require("../models/Order");
const Cart = require("../models/Cart");
const SellerWallet = require("../models/SellerWallet");
const SellerLedgerEntry = require("../models/SellerLedgerEntry");
const SellerMoneyRequest = require("../models/SellerMoneyRequest");
const SellerNotification = require("../models/SellerNotification");
const OrderNotification = require("../models/OrderNotification");
const AdminNotification = require("../models/AdminNotification");
const AdminAuditLog = require("../models/AdminAuditLog");
const PaymentMethod = require("../models/PaymentMethod");
const ChatConversation = require("../models/ChatConversation");
const ChatMessage = require("../models/ChatMessage");
const MarketplaceCategory = require("../models/MarketplaceCategory");

const base = process.env.SHOPVIOMALL_TEST_URL || "http://127.0.0.1:5000";
const runId = crypto.randomBytes(7).toString("hex");
const password = crypto.randomBytes(24).toString("base64url");
const prefix = `svmstage10${runId}`;
const created = { users: [], products: [], orders: [], requests: [], conversations: [], methods: [] };
const checks = [];

function check(name, condition) {
  checks.push({ name, pass: Boolean(condition) });
  if (!condition) throw new Error(`Verification failed: ${name}`);
}

async function api(path, { token, method = "GET", body, headers = {}, expected } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let data = {};
  try { data = await response.json(); } catch { /* Keep response status for assertion. */ }
  if (expected && !expected.includes(response.status)) throw new Error(`Unexpected HTTP ${response.status} for ${method} ${path}.`);
  if (!expected && !response.ok) throw new Error(`HTTP ${response.status} for ${method} ${path}.`);
  return { response, data };
}

async function login(identifier, isAdmin = false) {
  const payload = isAdmin ? { username: identifier, password } : { email: identifier, password };
  const result = await api("/api/auth/login", { method: "POST", body: payload });
  check(`${isAdmin ? "admin" : "user"} login returns a role-scoped session`, Boolean(result.data.token && result.data.user?.role));
  return result.data.token;
}

async function createUser(role, suffix, extra = {}) {
  const fields = {
    name: `Stage 10 ${suffix}`,
    email: `${prefix}-${suffix}@example.invalid`,
    password,
    role,
    ...(role === "admin" ? { username: `${prefix}admin` } : {}),
    ...(role === "vendor" ? { shopName: `Stage 10 ${runId}`, shopSlug: `stage-10-${runId}`, shopBio: "Temporary verification shop", walletAddress: `test-wallet-${runId}`, accountStatus: "approved", kycStatus: "approved" } : {}),
    ...extra
  };
  const user = await User.create(fields);
  created.users.push(user._id);
  return user;
}

async function createOrder(customerToken, productId, title) {
  await api("/api/cart/items", { token: customerToken, method: "POST", body: { productId: String(productId), quantity: 1 } });
  const result = await api("/api/orders/checkout", {
    token: customerToken,
    method: "POST",
    headers: { "Idempotency-Key": `${prefix}-${crypto.randomBytes(8).toString("hex")}` },
    body: { shippingAddress: { recipient: "Stage 10 Test", line1: "Temporary test address", city: "Test City", country: "Test" } }
  });
  check(`${title} checkout uses server-side totals`, result.response.status === 201 && result.data.order.total > 0);
  created.orders.push(result.data.order.orderNumber);
  return result.data.order;
}

async function cleanup() {
  const uid = { $in: created.users };
  const ids = [...created.users, ...created.products, ...created.conversations, ...created.methods];
  const orderFilter = created.orders.length ? { orderNumber: { $in: created.orders } } : { _id: { $in: [] } };
  await Promise.all([
    ChatMessage.deleteMany({ conversationId: { $in: created.conversations } }),
    ChatConversation.deleteMany({ $or: [{ _id: { $in: created.conversations } }, { userId: uid }] }),
    OrderNotification.deleteMany({ $or: [{ recipientId: uid }, { orderId: { $in: (await Order.find(orderFilter).distinct("_id")) } }] }),
    AdminNotification.deleteMany({ targetId: { $in: ids } }),
    AdminAuditLog.deleteMany({ $or: [{ adminId: uid }, { targetId: { $in: ids } }] }),
    SellerNotification.deleteMany({ recipientId: uid }),
    SellerLedgerEntry.deleteMany({ sellerId: uid }),
    SellerWallet.deleteMany({ sellerId: uid }),
    SellerMoneyRequest.deleteMany({ $or: [{ sellerId: uid }, { _id: { $in: created.requests } }] }),
    Cart.deleteMany({ customerId: uid }),
    Order.deleteMany(orderFilter),
    Product.deleteMany({ $or: [{ _id: { $in: created.products } }, { sellerId: uid }] }),
    PaymentMethod.deleteMany({ _id: { $in: created.methods } }),
    User.deleteMany({ _id: uid })
  ]);
  const remaining = await Promise.all([
    User.countDocuments({ _id: uid }), Product.countDocuments({ $or: [{ _id: { $in: created.products } }, { sellerId: uid }] }),
    Order.countDocuments(orderFilter), Cart.countDocuments({ customerId: uid }),
    SellerMoneyRequest.countDocuments({ $or: [{ sellerId: uid }, { _id: { $in: created.requests } }] }),
    SellerLedgerEntry.countDocuments({ sellerId: uid }), SellerWallet.countDocuments({ sellerId: uid }),
    SellerNotification.countDocuments({ recipientId: uid }), OrderNotification.countDocuments({ recipientId: uid }),
    AdminNotification.countDocuments({ targetId: { $in: ids } }), AdminAuditLog.countDocuments({ $or: [{ adminId: uid }, { targetId: { $in: ids } }] }),
    ChatConversation.countDocuments({ $or: [{ _id: { $in: created.conversations } }, { userId: uid }] }),
    ChatMessage.countDocuments({ conversationId: { $in: created.conversations } }), PaymentMethod.countDocuments({ _id: { $in: created.methods } })
  ]);
  if (remaining.some((count) => count !== 0)) throw new Error("One or more exact temporary fixture sets remain after cleanup.");
  console.log("TEMP_CLEANUP=PASS");
}

async function main() {
  if (process.env.STAGE10_ALLOW_TEMP_DATA !== "YES") throw new Error("Set STAGE10_ALLOW_TEMP_DATA=YES to authorize temporary database fixtures.");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured.");
  const health = await api("/api/health");
  check("server health reports a connected database", health.response.status === 200 && health.data.database === "connected");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
  const category = await MarketplaceCategory.findOne({ archived: { $ne: true } }).lean();
  if (!category) throw new Error("No active marketplace category is available for temporary products.");

  const admin = await createUser("admin", "admin");
  const seller = await createUser("vendor", "seller");
  const otherSeller = await createUser("vendor", "seller-other", { shopName: `Other test ${runId}`, shopSlug: `other-test-${runId}` });
  const customer = await createUser("customer", "customer");
  const otherCustomer = await createUser("customer", "customer-other");
  const [adminToken, sellerToken, otherSellerToken, customerToken, otherCustomerToken] = await Promise.all([
    login(admin.username, true), login(seller.email), login(otherSeller.email), login(customer.email), login(otherCustomer.email)
  ]);
  check("customer and vendor are denied Admin Central APIs", (await api("/api/admin/dashboard", { token: customerToken, expected: [403] })).response.status === 403 && (await api("/api/admin/dashboard", { token: sellerToken, expected: [403] })).response.status === 403);
  check("customer and admin are denied vendor product management", (await api("/api/seller/products", { token: customerToken, expected: [403] })).response.status === 403 && (await api("/api/seller/products", { token: adminToken, expected: [403] })).response.status === 403);

  const sellerProfile = await api("/api/seller/profile", { token: sellerToken });
  check("seller profile is loaded from the authenticated database account", sellerProfile.data.profile?.shopSlug === seller.shopSlug);
  const productPayload = (title, price, stock = 8) => ({ title, description: "Temporary Stage 10 verification listing.", category: category.name, subcategory: category.subcategories?.[0] || "", price, baseCost: Math.min(price / 2, price), stock, status: "active", sku: `${prefix}-${title.replace(/\W/g, "").slice(-8)}` });
  const liveProduct = (await api("/api/seller/products", { token: sellerToken, method: "POST", body: productPayload(`S10 ${runId} live`, 100) })).data.product;
  created.products.push(liveProduct._id);
  const archiveProduct = (await api("/api/seller/products", { token: sellerToken, method: "POST", body: productPayload(`S10 ${runId} archive`, 20) })).data.product;
  created.products.push(archiveProduct._id);
  const updatedProduct = await api(`/api/seller/products/${archiveProduct._id}`, { token: sellerToken, method: "PATCH", body: { title: `${archiveProduct.title} updated` } });
  check("seller can update own product", updatedProduct.data.product.title.endsWith("updated"));
  const ownerBlocked = await api(`/api/seller/products/${liveProduct._id}`, { token: otherSellerToken, method: "PATCH", body: { title: "Unauthorized change" }, expected: [404] });
  check("seller product ownership is enforced", ownerBlocked.response.status === 404);
  await api(`/api/seller/products/${archiveProduct._id}`, { token: sellerToken, method: "DELETE" });
  check("seller can archive own product", (await Product.findById(archiveProduct._id).lean()).status === "archived");
  const catalog = await api(`/api/products?q=${encodeURIComponent(runId)}&category=${encodeURIComponent(category.name)}&sort=price-asc&page=1&limit=5`);
  check("database marketplace search/category/sorting/pagination returns the active test listing", catalog.data.products.some((item) => String(item._id) === String(liveProduct._id)) && catalog.data.page === 1);
  const detail = await api(`/api/products/${liveProduct._id}`);
  check("product detail returns live MongoDB seller data", detail.data.product?.sellerId?.shopName === seller.shopName);
  check("customer can read vendor product details but not management API", (await api(`/api/products/${liveProduct._id}`)).response.ok && (await api("/api/seller/products", { token: customerToken, expected: [403] })).response.status === 403);

  const method = await PaymentMethod.create({ asset: `TEST${runId.slice(0, 6)}`, symbol: "USD", network: `Stage10-${runId}`, receivingAddress: `test-address-${runId}`, enabled: true, minimumDeposit: 1 });
  created.methods.push(method._id);
  const deposit = (await api("/api/seller/money-requests/deposit", { token: sellerToken, method: "POST", body: { amount: 30, paymentMethodId: String(method._id), note: `temporary-${runId}` } })).data.request;
  created.requests.push(deposit._id);
  const depositApproval = { status: "approved", note: `Stage 10 isolated test ${runId}`, txid: `TEST-NO-TRANSFER-${runId}`, network: method.network };
  await api(`/api/admin/money-requests/${deposit._id}`, { token: adminToken, method: "PATCH", body: depositApproval });
  const duplicateDeposit = await api(`/api/admin/money-requests/${deposit._id}`, { token: adminToken, method: "PATCH", body: depositApproval, expected: [409] });
  const depositCredits = await SellerLedgerEntry.countDocuments({ relatedRequestId: deposit._id, type: "deposit" });
  check("deposit approval credits exactly once and retry is rejected", duplicateDeposit.response.status === 409 && depositCredits === 1);

  const order = await createOrder(customerToken, liveProduct._id, "paid order");
  await api(`/api/admin/orders/${order.orderNumber}/payment`, { token: adminToken, method: "PATCH", body: { paymentStatus: "paid", reference: `TEST-NO-TRANSFER-${runId}`, reason: `Temporary isolated verification ${runId}` } });
  await api(`/api/admin/orders/${order.orderNumber}/payment`, { token: adminToken, method: "PATCH", body: { paymentStatus: "paid", reference: `TEST-NO-TRANSFER-${runId}`, reason: `Temporary isolated verification ${runId}` } });
  const orderAfterPay = await Order.findOne({ orderNumber: order.orderNumber }).lean();
  const holdCount = await SellerLedgerEntry.countDocuments({ relatedOrderId: orderAfterPay._id, type: "order_hold" });
  check("qualifying order payment creates one hold despite repeat", orderAfterPay.paymentStatus === "paid" && holdCount === 1 && orderAfterPay.fulfillments[0].walletHoldStatus === "held");
  const heldWallet = await SellerWallet.findOne({ sellerId: seller._id, currency: "USD" }).lean();
  const heldWithdrawal = await api("/api/seller/money-requests/withdrawal", { token: sellerToken, method: "POST", body: { amount: 31, paymentMethodId: String(method._id), walletAddress: seller.walletAddress, note: "held-funds rejection" }, expected: [409] });
  check("withdrawal cannot consume held funds", heldWithdrawal.response.status === 409 && heldWallet.availableBalance === 30 && heldWallet.heldBalance > 30);

  const withdrawal = (await api("/api/seller/money-requests/withdrawal", { token: sellerToken, method: "POST", body: { amount: 20, paymentMethodId: String(method._id), walletAddress: seller.walletAddress, note: `temporary-${runId}` } })).data.request;
  created.requests.push(withdrawal._id);
  const withdrawalApproval = { status: "approved", note: `Stage 10 isolated test ${runId}` };
  await api(`/api/admin/money-requests/${withdrawal._id}`, { token: adminToken, method: "PATCH", body: withdrawalApproval });
  const markPaid = { status: "paid", txid: `TEST-NO-TRANSFER-${runId}`, network: method.network, note: `Temporary record only; no transfer ${runId}` };
  await api(`/api/admin/money-requests/${withdrawal._id}`, { token: adminToken, method: "PATCH", body: markPaid });
  const duplicateWithdrawal = await api(`/api/admin/money-requests/${withdrawal._id}`, { token: adminToken, method: "PATCH", body: markPaid, expected: [409] });
  const withdrawalDebits = await SellerLedgerEntry.countDocuments({ relatedRequestId: withdrawal._id, type: "withdrawal", status: "completed" });
  check("withdrawal completion records one debit; no external transfer occurs", duplicateWithdrawal.response.status === 409 && withdrawalDebits === 1);

  const firstFulfillment = orderAfterPay.fulfillments[0];
  for (const status of ["processing", "packed", "shipped", "in_transit", "out_for_delivery"]) {
    await api(`/api/orders/seller/fulfillments/${firstFulfillment.publicId}`, { token: sellerToken, method: "PATCH", body: { status, ...(status === "shipped" ? { carrier: "Temporary carrier", trackingNumber: `TEST-${runId}` } : {}) } });
  }
  await api(`/api/orders/${order.orderNumber}/fulfillments/${firstFulfillment.publicId}/confirm-delivery`, { token: customerToken, method: "POST", body: {} });
  await api(`/api/orders/${order.orderNumber}/fulfillments/${firstFulfillment.publicId}/confirm-delivery`, { token: customerToken, method: "POST", body: {} });
  const releases = await SellerLedgerEntry.countDocuments({ relatedOrderId: orderAfterPay._id, type: "order_release" });
  const walletAfterDelivery = await SellerWallet.findOne({ sellerId: seller._id, currency: "USD" }).lean();
  check("delivery releases held earnings exactly once and leaves nonnegative balances", releases === 1 && walletAfterDelivery.availableBalance >= 0 && walletAfterDelivery.heldBalance >= 0);

  const refundProduct = (await api("/api/seller/products", { token: sellerToken, method: "POST", body: productPayload(`S10 ${runId} refund`, 40, 5) })).data.product;
  created.products.push(refundProduct._id);
  const refundOrder = await createOrder(customerToken, refundProduct._id, "refund order");
  await api(`/api/admin/orders/${refundOrder.orderNumber}/payment`, { token: adminToken, method: "PATCH", body: { paymentStatus: "paid", reference: `TEST-NO-TRANSFER-${runId}`, reason: `Temporary isolated verification ${runId}` } });
  await api(`/api/orders/${refundOrder.orderNumber}/refund-request`, { token: customerToken, method: "POST", body: { reason: `Temporary test refund ${runId}` } });
  const refundOrderDoc = await Order.findOne({ orderNumber: refundOrder.orderNumber }).lean();
  await api(`/api/admin/orders/${refundOrder.orderNumber}/payment`, { token: adminToken, method: "PATCH", body: { paymentStatus: "refunded", reference: `TEST-REFUND-NO-TRANSFER-${runId}`, reason: `Temporary ledger reversal only ${runId}` } });
  await api(`/api/admin/orders/${refundOrder.orderNumber}/payment`, { token: adminToken, method: "PATCH", body: { paymentStatus: "refunded", reference: `TEST-REFUND-NO-TRANSFER-${runId}`, reason: `Temporary ledger reversal only ${runId}` } });
  const refundCount = await SellerLedgerEntry.countDocuments({ relatedOrderId: refundOrderDoc._id, type: "refund" });
  check("refund reversal occurs exactly once", refundCount === 1 && (await Order.findOne({ orderNumber: refundOrder.orderNumber }).lean()).paymentStatus === "refunded");

  const cancellationProduct = (await api("/api/seller/products", { token: sellerToken, method: "POST", body: productPayload(`S10 ${runId} cancel`, 15, 4) })).data.product;
  created.products.push(cancellationProduct._id);
  const stockBeforeCancel = (await Product.findById(cancellationProduct._id).lean()).stock;
  const cancelledOrder = await createOrder(customerToken, cancellationProduct._id, "unpaid cancellation order");
  await api(`/api/orders/${cancelledOrder.orderNumber}/cancel`, { token: customerToken, method: "POST", body: {} });
  await api(`/api/orders/${cancelledOrder.orderNumber}/cancel`, { token: customerToken, method: "POST", body: {} });
  const stockAfterCancel = (await Product.findById(cancellationProduct._id).lean()).stock;
  check("cancellation restores inventory exactly once", stockAfterCancel === stockBeforeCancel);

  const conversation = (await api("/api/chat/conversations/open", { token: customerToken, method: "POST", body: {} })).data.conversation;
  created.conversations.push(conversation.id);
  await api(`/api/chat/conversations/${conversation.id}/messages`, { token: customerToken, method: "POST", body: { body: `Temporary support check ${runId}` } });
  const forbiddenThread = await api(`/api/chat/conversations/${conversation.id}/messages`, { token: otherCustomerToken, expected: [404] });
  const adminInbox = await api("/api/chat/admin/conversations", { token: adminToken });
  check("chat is owner-scoped and visible in admin inbox", forbiddenThread.response.status === 404 && adminInbox.data.conversations.some((item) => item.id === conversation.id));
  await api(`/api/chat/admin/conversations/${conversation.id}/messages`, { token: adminToken, method: "POST", body: { body: `Temporary admin reply ${runId}` } });
  const persistedChat = await api(`/api/chat/conversations/${conversation.id}/messages`, { token: customerToken });
  check("admin reply persists in the customer conversation", persistedChat.data.messages.some((item) => item.senderRole === "admin"));

  const adminApiPaths = ["dashboard", "customers", "sellers", "applications", "products", "categories", "wallets", "money-requests", "notifications", "audit", "orders", "settings"];
  for (const path of adminApiPaths) {
    const result = await api(`/api/admin/${path}?limit=10`, { token: adminToken });
    check(`admin API ${path} is reachable`, result.response.ok);
  }
  const adminCustomerList = await api(`/api/admin/customers?q=${encodeURIComponent(prefix)}&limit=10`, { token: adminToken });
  const customerRow = adminCustomerList.data.customers.find((row) => String(row._id) === String(customer._id));
  check("admin customer list excludes password hashes and finds temporary customer", Boolean(customerRow) && !("password" in customerRow));
  await api(`/api/admin/customers/${customer._id}/status`, { token: adminToken, method: "PATCH", body: { status: "suspended", reason: `Temporary verification ${runId}` } });
  await api(`/api/admin/customers/${customer._id}/status`, { token: adminToken, method: "PATCH", body: { status: "active", reason: `Temporary verification cleanup ${runId}` } });
  check("admin customer status action persists", (await User.findById(customer._id).lean()).customerStatus === "active");

  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu", "--disable-gpu-compositing", "--disable-features=Vulkan,UseSkiaRenderer"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base, { waitUntil: "domcontentloaded" });
    const accessibility = await page.evaluate(() => {
      const visible = (el) => Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden";
      const controls = [...document.querySelectorAll("button,a[href],input,select,textarea")].filter(visible);
      const unnamed = controls.filter((el) => {
        const label = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.title || el.innerText || el.value || el.labels?.[0]?.innerText || "";
        return !label.trim();
      }).map((el) => `${el.tagName.toLowerCase()}#${el.id || ""}.${String(el.className || "").split(" ")[0]}`);
      return {
        lang: document.documentElement.lang,
        main: document.querySelectorAll("main").length,
        headings: document.querySelectorAll("h1").length,
        unnamed,
        missingAlt: [...document.images].filter((img) => !img.hasAttribute("alt")).length,
        focusStyle: Boolean([...document.styleSheets].some((sheet) => { try { return [...sheet.cssRules].some((rule) => rule.cssText.includes(":focus-visible")); } catch { return false; } }))
      };
    });
    check("homepage accessibility landmarks and metadata", accessibility.lang && accessibility.main >= 1 && accessibility.headings >= 1 && accessibility.missingAlt === 0 && accessibility.focusStyle);
    check("visible controls have accessible names", accessibility.unnamed.length === 0);
    const scanAccessibility = async (pageName) => {
      await page.addScriptTag({ content: axeSource });
      const result = await page.evaluate(async () => axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } }));
      for (const violation of result.violations) {
        console.log(`A11Y_VIOLATION ${pageName}: ${violation.id} impact=${violation.impact || "unknown"} nodes=${violation.nodes.length}`);
      }
      check(`axe WCAG accessibility scan ${pageName}`, result.violations.length === 0);
    };
    await scanAccessibility("homepage");
    await page.locator("#login-open").click();
    await scanAccessibility("login-modal");
    for (const width of [390, 768, 1365]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      check(`responsive layout at ${width}px`, !overflow);
    }

    await page.goto(new URL("/admin", base).href, { waitUntil: "domcontentloaded" });
    await page.locator('#login-form input[name="identifier"]').fill(admin.username);
    await page.locator('#login-form input[name="password"]').fill(password);
    await page.locator('#login-form button[type="submit"]').click();
    await page.locator("#admin-central").waitFor({ state: "visible", timeout: 12000 });
    check("temporary admin can log in through browser and open Admin Central", true);
    await scanAccessibility("admin-central");
    const navPages = ["dashboard", "customers", "wallets", "sellers", "applications", "products", "categories", "orders", "deposits", "withdrawals", "transactions", "messages", "notifications", "audit"];
    for (const nav of navPages) {
      await page.locator(`[data-admin-page="${nav}"]`).click();
      await page.waitForTimeout(250);
      const selected = await page.locator(`[data-admin-page="${nav}"]`).getAttribute("aria-current");
      check(`Admin Central browser navigation ${nav}`, selected === "page");
    }

    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.locator("#login-open").click();
    await page.locator('#login-form input[name="identifier"]').fill(seller.email);
    await page.locator('#login-form input[name="password"]').fill(password);
    await page.locator('#login-form button[type="submit"]').click();
    await page.locator("#seller-dashboard-open").waitFor({ state: "visible", timeout: 12000 });
    await page.locator("#seller-dashboard-open").click();
    await page.locator("#seller-dashboard").waitFor({ state: "visible" });
    check("temporary approved seller can open Seller Central", true);
    await scanAccessibility("seller-central");
    if (errors.length) throw new Error(`Browser application errors occurred (${errors.length}).`);
    check("browser emitted no uncaught application errors", true);
  } finally {
    await browser.close();
  }

  console.log(`STAGE10_CHECKS_PASSED=${checks.filter((item) => item.pass).length}/${checks.length}`);
  for (const item of checks) console.log(`${item.pass ? "PASS" : "FAIL"}: ${item.name}`);
}

main().catch((error) => {
  console.error(`STAGE10_E2E=FAIL (${error.name}: ${String(error.message || "").replace(/[\r\n]/g, " ").slice(0, 220)})`);
  process.exitCode = 1;
}).finally(async () => {
  try { if (mongoose.connection.readyState) await cleanup(); } catch (error) { console.error(`TEMP_CLEANUP=VERIFY_REQUIRED (${error.name})`); process.exitCode = 1; }
  try { await mongoose.disconnect(); } catch { /* Keep cleanup report authoritative. */ }
});
