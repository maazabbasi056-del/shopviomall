"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  APPROVED_IP,
  assessServerReport,
  alertDecision,
  checkDns,
  checkHttp,
  checkRegistration,
  collectSnapshot,
  createConfig,
  recordNotificationFailure,
  sendResendAlert,
} = require("../scripts/monitor-production");

function dnsAdapter({ badResolver = null, badAuthority = false } = {}) {
  return async (server, host, type) => {
    if (host === "shopviomall.com" && type === "NS") return ["dns1.registrar-servers.com", "dns2.registrar-servers.com"];
    if (host.endsWith("registrar-servers.com") && type === "A") return [{ address: server.includes("registrar") ? server : "192.0.2.10" }];
    if (type === "AAAA") return [];
    if (type === "A") {
      const isAuthority = server.startsWith("192.0.2.");
      return (badResolver === server || (badAuthority && isAuthority)) ? [{ address: "198.54.117.242" }] : [{ address: APPROVED_IP }];
    }
    return [];
  };
}

test("DNS monitor flags public and authoritative parking-IP answers", async () => {
  const result = await checkDns({ publicResolvers: ["8.8.8.8"] }, dnsAdapter({ badResolver: "8.8.8.8", badAuthority: true }));
  assert.equal(result.ok, false);
  assert.match(result.failures.join(" "), /198\.54\.117\.242/);
});

test("HTTP checks require API health JSON to report a connected database", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    if (String(url).startsWith("http://")) return { ok: false, status: 301, headers: { get: () => "https://shopviomall.com/" }, body: { cancel: async () => {} } };
    return {
      ok: true,
      status: 200,
      url: String(url),
      body: { cancel: async () => {} },
      json: async () => ({ success: true, status: "ok", database: "disconnected" }),
    };
  };
  const config = createConfig({}, ["--no-alerts", "--skip-server"]);
  const result = await checkHttp(config, fakeFetch);
  assert.equal(result.homepage.ok, true);
  assert.equal(result.www.ok, true);
  assert.equal(result.sellerStorefront.ok, true);
  assert.equal(result.httpRedirect.ok, true);
  assert.equal(result.apiHealth.ok, false);
  assert.equal(calls.find((call) => call.url.endsWith("/api/health")).method, "GET");
});

test("monitor rejects non-ShopVioMall monitor URLs and wrong health paths", () => {
  assert.throws(() => createConfig({ MONITOR_BASE_URL: "https://example.org" }), /must use HTTPS on shopviomall/);
  assert.throws(() => createConfig({ MONITOR_HEALTH_URL: "https://shopviomall.com/admin" }), /path must be/);
});

test("RDAP monitor detects registration holds and reads expiration without claiming email verification", async () => {
  const response = {
    ok: true,
    json: async () => ({ status: ["client transfer prohibited", "serverHold"], events: [{ eventAction: "expiration", eventDate: "2027-09-25T00:00:00Z" }] }),
  };
  const result = await checkRegistration({ registrationUrl: "https://rdap.verisign.com/com/v1/domain/shopviomall.com", timeoutMs: 1000 }, async () => response, Date.parse("2026-10-11T00:00:00Z"));
  assert.equal(result.ok, false);
  assert.deepEqual(result.holdStatuses, ["serverhold"]);
  assert.equal(result.registrantVerificationObservable, false);
  assert.ok(result.daysRemaining > 300);
});

test("critical alert requires two consecutive matching failures and recovery notifies once", () => {
  const snapshot = { checkedAt: "2026-10-11T00:00:00.000Z", critical: ["DNS mismatch"], warnings: [] };
  const first = alertDecision(snapshot, {});
  assert.equal(first.event, "none");
  const second = alertDecision(snapshot, first.state);
  assert.equal(second.event, "alert");
  assert.equal(alertDecision(snapshot, second.state).event, "none");
  const healthy = alertDecision({ checkedAt: "2026-10-11T00:05:00.000Z", critical: [], warnings: [] }, second.state);
  assert.equal(healthy.event, "recovery");
  assert.equal(alertDecision({ checkedAt: "2026-10-11T00:10:00.000Z", critical: [], warnings: [] }, healthy.state).event, "none");
});

test("warning notifications are transition-based, avoiding repeat expiry email", () => {
  const warn = { checkedAt: "now", critical: [], warnings: ["Certificate expires in 29 days."] };
  const first = alertDecision(warn, {});
  assert.equal(first.event, "alert");
  assert.equal(alertDecision({ ...warn, warnings: ["Certificate expires in 28 days."] }, first.state).event, "none");
});

test("Resend failures report HTTP status but never echo authorization credentials", async () => {
  const secret = "never-echo-this-api-key";
  const config = { alertTo: "alerts@example.org", alertFrom: "ShopVioMall <support@shopviomall.com>", resendApiKey: secret };
  await assert.rejects(sendResendAlert(config, { subject: "test", body: "body" }, async (_url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${secret}`);
    return { ok: false, status: 403 };
  }), (error) => !error.message.includes(secret) && /HTTP 403/.test(error.message));
});

test("monitor email refuses unapproved sender identities", async () => {
  await assert.rejects(sendResendAlert({ alertTo: "ops@example.org", alertFrom: "personal@gmail.com", resendApiKey: "secret" }, { subject: "x", body: "y" }, async () => {
    throw new Error("must not send");
  }), /verified ShopVioMall support sender identity/);
});

test("failed alert delivery does not mark an incident as notified and remains retryable", () => {
  const previous = { pendingSignature: "CRITICAL: outage", pendingCount: 1, lastNotifiedSignature: "" };
  const proposed = { pendingSignature: "CRITICAL: outage", pendingCount: 2, lastNotifiedSignature: "CRITICAL: outage" };
  const state = recordNotificationFailure(proposed, previous, new Error("Resend HTTP 503"), "now");
  assert.equal(state.lastNotifiedSignature, "");
  assert.match(state.notificationFailure.message, /503/);
  const retry = alertDecision({ checkedAt: "later", critical: ["outage"], warnings: [] }, state);
  assert.equal(retry.event, "alert");
});

test("snapshot reports missing optional SSH monitoring as setup warning, not healthy coverage", async () => {
  const config = { ...createConfig({}, ["--no-alerts"]), publicResolvers: ["1.1.1.1"], skipServer: false };
  const snapshot = await collectSnapshot(config, {
    now: () => Date.parse("2026-10-11T00:00:00Z"),
    checkDns: async () => ({ ok: true, failures: [], resolvers: [{}], authoritative: [{}] }),
    checkHttp: async () => ({ homepage: { ok: true }, www: { ok: true }, sellerStorefront: { ok: true }, apiHealth: { ok: true } }),
    checkCertificate: async () => ({ ok: true, daysRemaining: 100, validTo: "2027-01-01T00:00:00Z" }),
    checkRegistration: async () => ({ ok: true, daysRemaining: 300, expiresAt: "2027-09-25T00:00:00Z", registrantVerificationObservable: false }),
    checkServer: async () => ({ configured: false, ok: false }),
  });
  assert.equal(snapshot.status, "healthy");
  assert.ok(snapshot.setupWarnings.some((item) => /VPS service\/resource probe is not configured/.test(item)));
  assert.equal(snapshot.ok, true);
});

test("VPS health assessment enforces resource/process thresholds and whitelists remote fields", () => {
  const config = { diskCriticalPercent: 90, memoryCriticalPercent: 10, memoryCriticalMb: 512 };
  const report = assessServerReport({ nginx: "active", pm2: "online", database: "connected", diskUsedPercent: 91, memoryAvailablePercent: 35, memoryAvailableMb: 2048, secret: "must-not-escape" }, config);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((item) => /Disk usage/.test(item)));
  assert.equal("secret" in report, false);
});

test("snapshot raises latency warnings and critical alerts using configured response-time thresholds", async () => {
  const config = createConfig({}, ["--no-alerts", "--skip-server"]);
  const snapshot = await collectSnapshot(config, {
    now: () => Date.parse("2026-10-11T00:00:00Z"),
    checkDns: async () => ({ ok: true, failures: [], resolvers: [{}], authoritative: [{}] }),
    checkHttp: async () => ({
      homepage: { ok: true, status: 200, elapsedMs: 3000 },
      www: { ok: true, status: 200, elapsedMs: 100 },
      sellerStorefront: { ok: true, status: 200, elapsedMs: 100 },
      apiHealth: { ok: true, status: 200, elapsedMs: 8100, database: "connected" },
    }),
    checkCertificate: async () => ({ ok: true, daysRemaining: 90, validTo: "2027-01-01T00:00:00Z" }),
    checkRegistration: async () => ({ ok: true, daysRemaining: 300, expiresAt: "2027-09-25T00:00:00Z", registrantVerificationObservable: false }),
  });
  assert.ok(snapshot.warnings.some((item) => /homepage response time/.test(item)));
  assert.ok(snapshot.critical.some((item) => /apiHealth response time/.test(item)));
  assert.equal(snapshot.status, "critical");
});
