"use strict";

const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { app } = require("../server");
const { cents } = require("../services/walletLedger");

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("readiness reports unavailable when MongoDB is disconnected", async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { success: false, status: "unavailable", database: "unavailable" });
});

test("HTTP responses include baseline security headers", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.match(response.headers.get("content-security-policy") || "", /object-src 'none'/);
});

test("repository source and environment paths are not served publicly", async () => {
  for (const path of ["/.env", "/server.js", "/package.json", "/routes/auth.js", "/middleware/auth.js"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} should not be public`);
  }
});

test("unknown API routes return a safe JSON 404", async () => {
  const response = await fetch(`${baseUrl}/api/not-a-route`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).message, "Endpoint not found.");
});

test("CORS permits configured local preview and rejects an unknown origin", async () => {
  const sameOrigin = await fetch(`${baseUrl}/api/not-a-route`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(sameOrigin.status, 404, "same-origin POST should reach the safe API 404, not be rejected by CORS");
  const allowed = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "http://localhost:5500" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5500");
  const denied = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "https://untrusted.invalid" } });
  assert.equal(denied.status, 403);
});

test("sensitive login writes are rate limited before database handling", async () => {
  let last;
  for (let attempt = 0; attempt < 31; attempt += 1) {
    last = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "rate-limit-test", password: "not-a-real-password" })
    });
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("ratelimit-limit")) >= 30);
});

test("wallet rounding uses currency precision", () => {
  assert.equal(cents(1.005, "USD"), 1.01);
  assert.equal(cents(1.123456789, "USDT"), 1.12345679);
});
