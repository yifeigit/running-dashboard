#!/usr/bin/env node
// Fetch COROS professional health/training metrics via MCP and save to a raw JSON file.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const REGION = "cn";
const ISSUER = "https://mcpcn.coros.com";
const MCP_URL = `${ISSUER}/mcp`;
const STATE_ROOT = path.join(homedir(), ".coros-mcp-skill-gateway-ts");
const TOKEN_PATH = path.join(STATE_ROOT, REGION, "token.json");
const CLIENT_NAME = "COROS MCP Gateway CLI";
const nowEpoch = () => Math.floor(Date.now() / 1000);
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

class HttpClient {
  cookies = new Map();
  async request(method, url, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    let body;
    if (options.form) { body = new URLSearchParams(options.form).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
    if (options.jsonBody !== undefined) { body = JSON.stringify(options.jsonBody); headers["Content-Type"] = "application/json"; }
    if (this.cookies.size > 0) headers.Cookie = Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    const resp = await fetch(url, { method, headers, body, redirect: "manual" });
    const getSetCookie = resp.headers.getSetCookie;
    const rawCookies = typeof getSetCookie === "function" ? getSetCookie.call(resp.headers) : [];
    for (const rc of rawCookies) { const [nv] = rc.split(";"); const sep = nv.indexOf("="); if (sep > 0) this.cookies.set(nv.slice(0, sep).trim(), nv.slice(sep + 1).trim()); }
    return resp;
  }
  async readJson(resp) {
    const raw = await resp.text();
    if (!raw) return {};
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      const payloads = []; let cur = [];
      for (const line of raw.split(/\r?\n/)) { if (!line) { if (cur.length) { payloads.push(cur.join("\n")); cur = []; } continue; } if (line.startsWith("data:")) cur.push(line.slice(5).trimStart()); }
      return payloads.length ? JSON.parse(payloads[payloads.length - 1]) : {};
    }
    return JSON.parse(raw);
  }
}
const http = new HttpClient();
function loadToken() { try { return JSON.parse(readFileSync(TOKEN_PATH, "utf8")); } catch { return undefined; } }
function isExpired(t, skew = 60) { return nowEpoch() + skew >= t.expires_at_epoch; }
async function registerClient() {
  const resp = await http.request("POST", `${ISSUER}/connect/register`, { jsonBody: { client_name: CLIENT_NAME, redirect_uris: ["http://127.0.0.1:43123/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "openid offline_access mcp.tools", token_endpoint_auth_method: "none" } });
  const payload = await http.readJson(resp);
  if (resp.status !== 200 && resp.status !== 201) throw new Error(`register failed: ${JSON.stringify(payload)}`);
  return payload.client_id;
}
async function refresh(t) {
  const clientId = t.client_id ?? await registerClient();
  const resp = await http.request("POST", `${ISSUER}/oauth2/token`, { form: { grant_type: "refresh_token", client_id: clientId, refresh_token: t.refresh_token } });
  const payload = await http.readJson(resp);
  if (resp.status !== 200) throw new Error(`refresh failed: ${JSON.stringify(payload)}`);
  const out = { access_token: payload.access_token, refresh_token: payload.refresh_token, expires_at_epoch: nowEpoch() + Number(payload.expires_in ?? 3600), token_type: String(payload.token_type ?? "Bearer"), scope: String(payload.scope ?? "openid offline_access mcp.tools"), client_id: clientId };
  writeFileSync(TOKEN_PATH, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  return out;
}
async function ensureToken() { let t = loadToken(); if (!t) throw new Error("no token cache; run coros-mcp login"); if (isExpired(t)) t = await refresh(t); return t; }
const authHeader = (t) => `${t.token_type} ${t.access_token}`;
async function mcpRequest(t, id, method, params) {
  const resp = await http.request("POST", MCP_URL, { headers: { Authorization: authHeader(t), Accept: "application/json, text/event-stream" }, jsonBody: { jsonrpc: "2.0", id, method, params } });
  const payload = await http.readJson(resp);
  if (resp.status !== 200) throw new Error(`mcp ${method} failed: ${JSON.stringify(payload)}`);
  if ("error" in payload) throw new Error(`mcp ${method} error: ${JSON.stringify(payload.error)}`);
  return payload;
}
async function callTool(name, args) {
  const t = await ensureToken();
  await mcpRequest(t, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: CLIENT_NAME, version: "1.0.0" } });
  const r = await mcpRequest(t, 2, "tools/call", { name, arguments: args });
  return r.result;
}
function toolText(result) {
  const item = (result?.content ?? []).find((c) => c.type === "text");
  if (!item) return null;
  let txt = item.text;
  try { txt = JSON.parse(txt); } catch { /* plain */ }
  return txt;
}

const out = {};
const jobs = [
  ["queryFitnessAssessmentOverview", {}],
  ["queryRecoveryStatus", {}],
  ["queryTrainingLoadAssessment", { days: 30 }],
  ["querySleepHrv", { days: 30 }],
  ["queryRestingHeartRate", { days: 30 }],
  ["queryAvgHeartRate", { days: 30 }],
  ["queryStressLevel", { days: 30 }],
  ["querySleepData", { days: 30 }],
  ["queryDailyHealthData", { days: 7 }],
  ["queryDevices", {}],
];
for (const [name, args] of jobs) {
  try {
    const r = await callTool(name, args);
    out[name] = { args, result: r, text: toolText(r) };
    console.log(`OK ${name}`);
  } catch (e) {
    out[name] = { args, error: e.message };
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const dest = process.argv[2] ?? "health_raw.json";
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`saved -> ${dest}`);
