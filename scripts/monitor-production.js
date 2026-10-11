#!/usr/bin/env node
"use strict";

const dns = require("node:dns").promises;
const { Resolver } = dns;
const tls = require("node:tls");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const execFileAsync = promisify(execFile);
const DOMAIN = "shopviomall.com";
const APPROVED_IP = "138.249.133.214";
const PUBLIC_RESOLVERS = ["8.8.8.8", "1.1.1.1", "9.9.9.9"];
const DEFAULTS = Object.freeze({
  baseUrl: `https://${DOMAIN}`,
  wwwUrl: `https://www.${DOMAIN}`,
  storefrontUrl: `https://${DOMAIN}/shop/luxsry-mall`,
  healthUrl: `https://${DOMAIN}/api/health`,
  registrationUrl: `https://rdap.verisign.com/com/v1/domain/${DOMAIN}`,
  publicResolvers: PUBLIC_RESOLVERS,
  timeoutMs: 12000,
  responseWarningMs: 2500,
  responseCriticalMs: 8000,
  certificateWarningDays: 30,
  certificateCriticalDays: 7,
  domainWarningDays: 60,
  domainCriticalDays: 14,
  diskCriticalPercent: 90,
  memoryCriticalPercent: 10,
  memoryCriticalMb: 512,
});

function oneLineError(error) {
  return String(error?.message || error || "Unknown failure").replace(/[\r\n\t]+/g, " ").slice(0, 220);
}

function validatePublicUrl(value, expectedPath = null) {
  const url = new URL(value);
  if (url.protocol !== "https:" || ![DOMAIN, `www.${DOMAIN}`].includes(url.hostname)) {
    throw new Error("Monitor URLs must use HTTPS on shopviomall.com or www.shopviomall.com.");
  }
  if (expectedPath && url.pathname !== expectedPath) throw new Error(`Monitor URL path must be ${expectedPath}.`);
  return url;
}

function createConfig(env = process.env, args = []) {
  const config = {
    ...DEFAULTS,
    baseUrl: env.MONITOR_BASE_URL || DEFAULTS.baseUrl,
    wwwUrl: env.MONITOR_WWW_URL || DEFAULTS.wwwUrl,
    storefrontUrl: env.MONITOR_STOREFRONT_URL || DEFAULTS.storefrontUrl,
    healthUrl: env.MONITOR_HEALTH_URL || DEFAULTS.healthUrl,
    alertTo: env.MONITOR_ALERT_TO || "",
    alertFrom: env.RESEND_FROM_EMAIL || "",
    resendApiKey: env.RESEND_API_KEY || "",
    sshTarget: env.MONITOR_SSH_TARGET || "",
    sshPrivateKey: env.MONITOR_SSH_PRIVATE_KEY || "",
    sshKnownHosts: env.MONITOR_SSH_KNOWN_HOSTS || "",
    stateFile: env.MONITOR_STATE_FILE || path.join(process.cwd(), ".local-data", "production-monitor-state.json"),
    noAlerts: args.includes("--no-alerts"),
    testEmail: args.includes("--test-email"),
    skipServer: args.includes("--skip-server"),
    jsonOnly: args.includes("--json"),
  };
  config.baseUrl = validatePublicUrl(config.baseUrl, "/").origin;
  config.wwwUrl = validatePublicUrl(config.wwwUrl, "/").origin;
  config.healthUrl = validatePublicUrl(config.healthUrl, "/api/health").href;
  const store = validatePublicUrl(config.storefrontUrl);
  if (!/^\/shop\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(store.pathname)) {
    throw new Error("The storefront monitor URL must use /shop/{public-shop-slug}.");
  }
  config.storefrontUrl = store.href;
  if (config.testEmail && config.noAlerts) throw new Error("--test-email cannot be combined with --no-alerts.");
  if (config.sshTarget && !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(config.sshTarget)) {
    throw new Error("MONITOR_SSH_TARGET must be a simple user@host value.");
  }
  const stateArg = args.find((arg) => arg.startsWith("--state-file="));
  if (stateArg) config.stateFile = path.resolve(stateArg.slice("--state-file=".length));
  return config;
}

function makeResolver(server) {
  const resolver = new Resolver();
  resolver.setServers([server]);
  return resolver;
}

async function resolveRecord(server, hostname, type) {
  const resolver = makeResolver(server);
  try {
    if (type === "A") return await resolver.resolve4(hostname, { ttl: true });
    if (type === "AAAA") return await resolver.resolve6(hostname, { ttl: true });
    if (type === "NS") return await resolver.resolveNs(hostname);
    return [];
  } catch (error) {
    if (["ENODATA", "ENOTFOUND"].includes(error.code) && type !== "NS") return [];
    throw error;
  }
}

function valuesOf(records) {
  return (records || []).map((record) => typeof record === "string" ? record : record.address).filter(Boolean).sort();
}

async function checkDns(config, resolver = resolveRecord) {
  const report = { expectedIp: APPROVED_IP, resolvers: [], authoritative: [], failures: [] };
  const publicResults = await Promise.all(config.publicResolvers.map(async (server) => {
    const row = { resolver: server, a: [], aaaa: [], ns: [], ok: false };
    try {
      [row.a, row.aaaa, row.ns] = await Promise.all([
        resolver(server, DOMAIN, "A"), resolver(server, DOMAIN, "AAAA"), resolver(server, DOMAIN, "NS"),
      ]);
      row.a = valuesOf(row.a);
      row.aaaa = valuesOf(row.aaaa);
      row.ns = row.ns.map((name) => name.toLowerCase()).sort();
      row.ok = row.a.length === 1 && row.a[0] === APPROVED_IP && row.aaaa.length === 0;
      if (!row.ok) report.failures.push(`Public resolver ${server} returned A=${row.a.join(",") || "none"}, AAAA=${row.aaaa.join(",") || "none"}.`);
    } catch (error) {
      report.failures.push(`Public resolver ${server} lookup failed: ${oneLineError(error)}`);
    }
    return row;
  }));
  report.resolvers = publicResults;
  const nameservers = [...new Set(publicResults.flatMap((row) => row.ns))];
  const nsAddresses = new Map();
  for (const name of nameservers) {
    for (const resolverIp of config.publicResolvers.slice(0, 1)) {
      try {
        const addresses = valuesOf(await resolver(resolverIp, name, "A"));
        if (addresses.length) nsAddresses.set(name, addresses);
      } catch (error) {
        report.failures.push(`Could not resolve authoritative nameserver ${name}: ${oneLineError(error)}`);
      }
    }
  }
  for (const [name, addresses] of nsAddresses) {
    for (const address of addresses) {
      const row = { nameserver: name, address, a: [], aaaa: [], ok: false };
      try {
        [row.a, row.aaaa] = await Promise.all([
          resolver(address, DOMAIN, "A"), resolver(address, DOMAIN, "AAAA"),
        ]);
        row.a = valuesOf(row.a);
        row.aaaa = valuesOf(row.aaaa);
        row.ok = row.a.length === 1 && row.a[0] === APPROVED_IP && row.aaaa.length === 0;
        if (!row.ok) report.failures.push(`Authoritative ${name} returned A=${row.a.join(",") || "none"}, AAAA=${row.aaaa.join(",") || "none"}.`);
      } catch (error) {
        report.failures.push(`Authoritative ${name} query failed: ${oneLineError(error)}`);
      }
      report.authoritative.push(row);
    }
  }
  if (!nameservers.length) report.failures.push("Public DNS resolvers returned no authoritative NS records.");
  if (!report.authoritative.length) report.failures.push("No authoritative nameserver answers were verified.");
  report.ok = report.failures.length === 0;
  return report;
}

async function timedFetch(url, { method = "GET", timeoutMs = DEFAULTS.timeoutMs, fetchImpl = fetch, headers = {} } = {}) {
  const started = Date.now();
  const response = await fetchImpl(url, { method, redirect: "follow", headers, signal: AbortSignal.timeout(timeoutMs) });
  const finalUrl = new URL(response.url || url);
  if (![DOMAIN, `www.${DOMAIN}`].includes(finalUrl.hostname)) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, status: response.status, elapsedMs: Date.now() - started, error: "Unexpected redirect outside the ShopVioMall domain." };
  }
  const result = { status: response.status, elapsedMs: Date.now() - started, ok: response.status >= 200 && response.status < 400 };
  return { ...result, response };
}

async function checkHttp(config, fetchImpl = fetch) {
  const probes = [
    ["homepage", `${config.baseUrl}/`, "HEAD"],
    ["www", `${config.wwwUrl}/`, "HEAD"],
    ["sellerStorefront", config.storefrontUrl, "GET"],
    ["apiHealth", config.healthUrl, "GET"],
  ];
  const results = {};
  for (const [key, url, method] of probes) {
    try {
      const result = await timedFetch(url, { method, timeoutMs: config.timeoutMs, fetchImpl, headers: { "user-agent": "ShopVioMall-External-Monitor/1.0" } });
      const response = result.response;
      if (!response) {
        results[key] = { ok: false, status: result.status || 0, elapsedMs: result.elapsedMs, error: result.error };
        continue;
      }
      let health = null;
      if (key === "apiHealth") {
        try { health = await response.json(); } catch { health = null; }
      } else if (response.body) {
        await response.body.cancel().catch(() => {});
      }
      const validHealth = key !== "apiHealth" || (health?.success === true && health?.status === "ok" && health?.database === "connected");
      results[key] = {
        ok: result.ok && validHealth,
        status: result.status,
        elapsedMs: result.elapsedMs,
        ...(key === "apiHealth" ? { database: health?.database || "unknown" } : {}),
        ...(!validHealth ? { error: "Health JSON did not report success, ok status, and connected database." } : {}),
      };
    } catch (error) {
      results[key] = { ok: false, status: 0, elapsedMs: null, error: oneLineError(error) };
    }
  }
  const redirectStarted = Date.now();
  try {
    const response = await fetchImpl(`http://${DOMAIN}/`, {
      method: "HEAD", redirect: "manual", headers: { "user-agent": "ShopVioMall-External-Monitor/1.0" },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const location = response.headers?.get?.("location") || "";
    const secureRedirect = [301, 302, 307, 308].includes(response.status)
      && /^https:\/\/(?:shopviomall\.com|www\.shopviomall\.com)(?:\/|$)/i.test(location);
    await response.body?.cancel().catch(() => {});
    results.httpRedirect = {
      ok: secureRedirect,
      status: response.status,
      elapsedMs: Date.now() - redirectStarted,
      ...(!secureRedirect ? { error: "HTTP did not redirect to the HTTPS ShopVioMall host." } : {}),
    };
  } catch (error) {
    results.httpRedirect = { ok: false, status: 0, elapsedMs: Date.now() - redirectStarted, error: oneLineError(error) };
  }
  return results;
}

function checkCertificate(hostname = DOMAIN, connect = tls.connect) {
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: 443, servername: hostname, rejectUnauthorized: true, timeout: 10000 }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
      socket.end();
      if (!validTo || Number.isNaN(validTo.getTime())) return resolve({ ok: false, error: "TLS peer did not provide a parseable certificate expiry." });
      const daysRemaining = (validTo.getTime() - Date.now()) / 86400000;
      resolve({ ok: daysRemaining > 0, validTo: validTo.toISOString(), daysRemaining: Math.floor(daysRemaining) });
    });
    socket.once("error", (error) => resolve({ ok: false, error: oneLineError(error) }));
    socket.once("timeout", () => { socket.destroy(); resolve({ ok: false, error: "TLS connection timed out." }); });
  });
}

async function checkRegistration(config, fetchImpl = fetch, now = Date.now()) {
  try {
    const response = await fetchImpl(config.registrationUrl, {
      headers: { accept: "application/rdap+json", "user-agent": "ShopVioMall-External-Monitor/1.0" },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) return { ok: false, observable: true, error: `RDAP returned HTTP ${response.status}.` };
    const body = await response.json();
    const statuses = Array.isArray(body.status) ? body.status.map((status) => String(status).toLowerCase()) : [];
    const holdStatuses = statuses.filter((status) => /(?:client|server)hold|pendingdelete|redemptionperiod|inactive/.test(status.replace(/[\s_-]/g, "")));
    const event = (body.events || []).find((item) => ["expiration", "registration expiration"].includes(String(item.eventAction || "").toLowerCase()));
    const expiresAt = event?.eventDate ? new Date(event.eventDate) : null;
    const daysRemaining = expiresAt && !Number.isNaN(expiresAt.getTime()) ? Math.floor((expiresAt.getTime() - now) / 86400000) : null;
    return {
      ok: holdStatuses.length === 0 && (daysRemaining === null || daysRemaining > 0),
      observable: true,
      statuses,
      holdStatuses,
      expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt.toISOString() : null,
      daysRemaining,
      registrantVerificationObservable: false,
    };
  } catch (error) {
    return { ok: false, observable: false, error: oneLineError(error), registrantVerificationObservable: false };
  }
}

async function runReadOnlyServerCheck(config) {
  if (!config.sshTarget || !config.sshPrivateKey || !config.sshKnownHosts) {
    return { configured: false, ok: false, error: "Restricted external SSH monitor is not configured." };
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shopviomall-monitor-"));
  const keyPath = path.join(tempDir, "monitor-key");
  const knownHostsPath = path.join(tempDir, "known_hosts");
  try {
    await fs.writeFile(keyPath, config.sshPrivateKey.endsWith("\n") ? config.sshPrivateKey : `${config.sshPrivateKey}\n`, { mode: 0o600 });
    await fs.writeFile(knownHostsPath, `${config.sshKnownHosts.trim()}\n`, { mode: 0o600 });
    const { stdout } = await execFileAsync("ssh", [
      "-T", "-i", keyPath, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
      "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsPath}`, "-o", "ConnectTimeout=8", "--", config.sshTarget,
    ], { timeout: 12000, maxBuffer: 64 * 1024, windowsHide: true });
    if (stdout.length > 8192) return { configured: true, ok: false, error: "Read-only VPS probe returned an oversized health document." };
    const value = JSON.parse(stdout.trim());
    return assessServerReport(value, config);
  } catch (error) {
    return { configured: true, ok: false, error: oneLineError(error) };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function assessServerReport(value, config = DEFAULTS) {
    const required = ["nginx", "pm2", "diskUsedPercent", "memoryAvailablePercent", "memoryAvailableMb", "database"];
    if (!value || typeof value !== "object" || required.some((key) => !(key in value))) return { configured: true, ok: false, error: "Read-only VPS probe returned an incomplete health document." };
    if (!["active", "inactive", "failed", "unknown"].includes(value.nginx)
      || !["online", "offline", "unknown"].includes(value.pm2)
      || !["connected", "disconnected", "unknown"].includes(value.database)
      || ![value.diskUsedPercent, value.memoryAvailablePercent, value.memoryAvailableMb].every(Number.isFinite)) {
      return { configured: true, ok: false, error: "Read-only VPS probe returned invalid field values." };
    }
    const failures = [];
    if (value.nginx !== "active") failures.push("Nginx is not active.");
    if (value.pm2 !== "online") failures.push("ShopVioMall PM2 process is not online.");
    if (value.database !== "connected") failures.push("Database is not connected according to local health.");
    if (!Number.isFinite(value.diskUsedPercent) || value.diskUsedPercent >= config.diskCriticalPercent) failures.push("Disk usage is at or above its critical threshold.");
    if (!Number.isFinite(value.memoryAvailablePercent) || value.memoryAvailablePercent < config.memoryCriticalPercent || value.memoryAvailableMb < config.memoryCriticalMb) failures.push("Available memory is below its critical threshold.");
    // Whitelist fields; even a malformed/compromised remote response cannot echo extra data.
    return {
      configured: true, ok: failures.length === 0,
      nginx: value.nginx, pm2: value.pm2, database: value.database,
      diskUsedPercent: value.diskUsedPercent,
      memoryAvailablePercent: value.memoryAvailablePercent,
      memoryAvailableMb: value.memoryAvailableMb,
      failures,
    };
}

async function collectSnapshot(config, adapters = {}) {
  const currentTime = adapters.now ? adapters.now() : Date.now();
  const [dnsResult, http, certificate, registration, server] = await Promise.all([
    (adapters.checkDns || checkDns)(config, adapters.resolveRecord),
    (adapters.checkHttp || checkHttp)(config, adapters.fetch || fetch),
    (adapters.checkCertificate || checkCertificate)(DOMAIN, adapters.tlsConnect || tls.connect),
    (adapters.checkRegistration || checkRegistration)(config, adapters.fetch || fetch, currentTime),
    config.skipServer ? Promise.resolve({ configured: false, skipped: true, ok: true }) : (adapters.checkServer || runReadOnlyServerCheck)(config),
  ]);
  const critical = [];
  const warnings = [];
  if (!dnsResult.ok) critical.push(...dnsResult.failures.map((failure) => `DNS: ${failure}`));
  for (const [name, result] of Object.entries(http)) {
    if (!result.ok) critical.push(`HTTP ${name}: ${result.error || `HTTP ${result.status}`}`);
    else if (Number.isFinite(result.elapsedMs) && result.elapsedMs >= config.responseCriticalMs) critical.push(`HTTP ${name} response time exceeds the critical threshold.`);
    else if (Number.isFinite(result.elapsedMs) && result.elapsedMs >= config.responseWarningMs) warnings.push(`HTTP ${name} response time exceeds the warning threshold.`);
  }
  if (!certificate.ok) critical.push(`TLS certificate: ${certificate.error || "certificate expired"}`);
  else if (certificate.daysRemaining <= config.certificateCriticalDays) critical.push(`TLS certificate expires in ${certificate.daysRemaining} days.`);
  else if (certificate.daysRemaining <= config.certificateWarningDays) warnings.push(`TLS certificate expires in ${certificate.daysRemaining} days.`);
  if (!registration.ok) critical.push(`Domain registration: ${registration.error || (registration.holdStatuses?.length ? `RDAP reports ${registration.holdStatuses.join(", ")}.` : "domain is expired")}`);
  else if (registration.daysRemaining !== null && registration.daysRemaining <= config.domainCriticalDays) critical.push(`Domain registration expires in ${registration.daysRemaining} days.`);
  else if (registration.daysRemaining !== null && registration.daysRemaining <= config.domainWarningDays) warnings.push(`Domain registration expires in ${registration.daysRemaining} days.`);
  if (!server.ok && server.configured) critical.push(...(server.failures || [server.error || "VPS health probe failed."]));
  const setupWarnings = [];
  if (!server.configured && !config.skipServer) setupWarnings.push("External VPS service/resource probe is not configured; website/API checks still run.");
  if (registration.registrantVerificationObservable === false) setupWarnings.push("RDAP cannot confirm Namecheap registrant-email verification; check the Namecheap dashboard and contact email manually.");
  return {
    checkedAt: new Date(currentTime).toISOString(),
    status: critical.length ? "critical" : warnings.length ? "warning" : "healthy",
    ok: critical.length === 0,
    critical,
    warnings,
    setupWarnings,
    dns: dnsResult,
    http,
    certificate,
    registration,
    server,
  };
}

function alertDecision(snapshot, state = {}) {
  const issues = [...snapshot.critical.map((item) => `CRITICAL: ${item}`), ...snapshot.warnings.map((item) => `WARNING: ${item}`)].sort();
  const signature = issues.map((item) => item.replace(/expires in \d+ days/g, "expires within the configured threshold")).join("\n");
  const next = { ...state, lastCheckedAt: snapshot.checkedAt };
  if (!issues.length) {
    next.pendingSignature = "";
    next.pendingCount = 0;
    const recover = Boolean(state.lastNotifiedSignature);
    next.lastNotifiedSignature = "";
    next.status = "healthy";
    return { state: next, event: recover ? "recovery" : "none", subject: recover ? "ShopVioMall monitoring recovery" : "", body: recover ? `ShopVioMall checks recovered at ${snapshot.checkedAt}.\n\nAll configured public, DNS, TLS, registration, and VPS checks are healthy.` : "" };
  }
  if (snapshot.critical.length) {
    next.pendingCount = state.pendingSignature === signature ? (Number(state.pendingCount) || 0) + 1 : 1;
    next.pendingSignature = signature;
    if (next.pendingCount < 2 || state.lastNotifiedSignature === signature) {
      next.status = "confirming_failure";
      return { state: next, event: "none", subject: "", body: "" };
    }
  } else {
    next.pendingSignature = signature;
    next.pendingCount = 1;
    if (state.lastNotifiedSignature === signature) return { state: { ...next, status: "warning" }, event: "none", subject: "", body: "" };
  }
  next.lastNotifiedSignature = signature;
  next.status = snapshot.critical.length ? "critical" : "warning";
  return {
    state: next,
    event: "alert",
    subject: `ShopVioMall ${next.status} production alert`,
    body: `Checked ${snapshot.checkedAt}\n\n${issues.join("\n")}\n\nPublic dashboard: https://shopviomall.com/api/health`,
  };
}

function recordNotificationFailure(nextState, previousState, error, at = new Date().toISOString()) {
  return {
    ...nextState,
    lastNotifiedSignature: previousState.lastNotifiedSignature || "",
    notificationFailure: { at, message: oneLineError(error) },
  };
}

function monitoringTestEmailDecision(snapshot) {
  return {
    subject: "[TEST] ShopVioMall monitoring email delivery",
    body: [
      "This is a monitoring delivery test only. It is not an outage alert and does not indicate a production incident.",
      `Check completed: ${snapshot.checkedAt}`,
      `Monitor result: ${snapshot.status}`,
      "No incident notification state was changed by this test.",
    ].join("\n\n"),
  };
}

async function sendMonitoringTestEmail(config, snapshot, send = sendResendAlert) {
  if (config.alertTo?.trim().toLowerCase() !== "sevenx729@gmail.com") {
    throw new Error("Monitoring test email recipient must be the owner-approved test address.");
  }
  const receipt = await send(config, monitoringTestEmailDecision(snapshot));
  return { sent: true, accepted: receipt?.ok === true, status: receipt?.status ?? null, event: "test" };
}

async function sendResendAlert(config, decision, fetchImpl = fetch) {
  if (!config.alertTo || !config.alertFrom || !config.resendApiKey) throw new Error("Email alert configuration is incomplete.");
  if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(config.alertTo) || config.alertTo.length > 254) throw new Error("Monitoring alert recipient is not a valid email address.");
  if (config.alertFrom.trim() !== "ShopVioMall <support@shopviomall.com>") throw new Error("Monitoring email must use the verified ShopVioMall support sender identity.");
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${config.resendApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: config.alertFrom, to: [config.alertTo], subject: decision.subject, text: decision.body }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Resend rejected the monitoring email with HTTP ${response.status}.`);
  return { ok: true, status: response.status };
}

async function loadState(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Could not read monitor state: ${oneLineError(error)}`);
  }
}

async function saveState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}

async function main() {
  const args = process.argv.slice(2);
  const config = createConfig(process.env, args);
  let snapshot;
  try {
    snapshot = await collectSnapshot(config);
  } catch (error) {
    const message = oneLineError(error);
    snapshot = {
      checkedAt: new Date().toISOString(), status: "critical", ok: false,
      critical: [`Monitor check could not complete: ${message}`], warnings: [], setupWarnings: [],
      dns: { ok: false, failures: ["DNS diagnostics did not complete."], resolvers: [], authoritative: [] },
      http: {}, certificate: { ok: false, error: "TLS check did not complete." },
      registration: { ok: false, error: "RDAP check did not complete." },
      server: { configured: Boolean(config.sshTarget), ok: false, error: "VPS check did not complete." },
    };
  }
  if (config.testEmail) {
    let notification = { sent: false, event: "test" };
    try {
      notification = await sendMonitoringTestEmail(config, snapshot);
    } catch (error) {
      notification.error = oneLineError(error);
      snapshot.critical.push(`Test email delivery failed: ${notification.error}`);
      snapshot.ok = false;
      snapshot.status = "critical";
    }
    const output = { ...snapshot, notification, testEmail: true };
    if (config.jsonOnly) process.stdout.write(`${JSON.stringify(output)}\n`);
    else process.stdout.write(`ShopVioMall monitoring test email: ${notification.sent ? "sent" : "failed"}; incident state unchanged.\n`);
    if (!snapshot.ok || (!config.skipServer && !snapshot.server.configured)) process.exitCode = 1;
    return;
  }
  const previousState = await loadState(config.stateFile);
  let state = previousState;
  const decision = alertDecision(snapshot, state);
  state = decision.state;
  let notification = { sent: false, event: decision.event };
  if (decision.event !== "none" && !config.noAlerts) {
    try {
      await sendResendAlert(config, decision);
      notification.sent = true;
      delete state.notificationFailure;
    } catch (error) {
      notification.error = oneLineError(error);
      state = recordNotificationFailure(state, previousState, error, snapshot.checkedAt);
      snapshot.critical.push(`Alert delivery failed: ${notification.error}`);
      snapshot.ok = false;
      snapshot.status = "critical";
    }
  }
  await saveState(config.stateFile, state);
  const output = { ...snapshot, notification };
  if (config.jsonOnly) process.stdout.write(`${JSON.stringify(output)}\n`);
  else {
    process.stdout.write(`ShopVioMall monitor ${snapshot.status} at ${snapshot.checkedAt}\n`);
    for (const [name, probe] of Object.entries(snapshot.http)) process.stdout.write(`HTTP ${name}: ${probe.ok ? "PASS" : "FAIL"} status=${probe.status} responseMs=${probe.elapsedMs ?? "n/a"}\n`);
    process.stdout.write(`DNS: ${snapshot.dns.ok ? "PASS" : "FAIL"} publicResolvers=${snapshot.dns.resolvers.length} authoritative=${snapshot.dns.authoritative.length}\n`);
    process.stdout.write(`TLS: ${snapshot.certificate.ok ? `PASS expires=${snapshot.certificate.validTo} days=${snapshot.certificate.daysRemaining}` : "FAIL"}\n`);
    process.stdout.write(`Registration: ${snapshot.registration.ok ? `PASS expires=${snapshot.registration.expiresAt || "unknown"} days=${snapshot.registration.daysRemaining ?? "unknown"}` : "FAIL"}\n`);
    process.stdout.write(`VPS probe: ${snapshot.server.configured ? (snapshot.server.ok ? "PASS" : "FAIL") : (snapshot.server.skipped ? "SKIPPED" : "NOT CONFIGURED")}\n`);
    for (const message of [...snapshot.critical, ...snapshot.warnings, ...snapshot.setupWarnings]) process.stdout.write(`- ${message}\n`);
    process.stdout.write(`Notification: ${notification.sent ? "sent" : notification.error ? "failed" : "not needed/disabled"}\n`);
  }
  if (!snapshot.ok || (!config.skipServer && !snapshot.server.configured)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Monitor could not complete: ${oneLineError(error)}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  APPROVED_IP,
  DOMAIN,
  DEFAULTS,
  alertDecision,
  checkCertificate,
  checkDns,
  checkHttp,
  checkRegistration,
  collectSnapshot,
  createConfig,
  assessServerReport,
  recordNotificationFailure,
  monitoringTestEmailDecision,
  sendMonitoringTestEmail,
  runReadOnlyServerCheck,
  sendResendAlert,
};

