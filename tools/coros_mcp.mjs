#!/usr/bin/env node
// Self-contained COROS MCP helper. Reads the local token cache produced by
// `coros-mcp login` and calls MCP tools directly, avoiding PowerShell quoting
// issues by reading tool arguments from a JSON file.
//
// Usage:
//   node tools/coros_mcp.mjs --tool querySportRecords --args-file args.json
//   node tools/coros_mcp.mjs --tool queryUserInfo
//   node tools/coros_mcp.mjs --list-tools
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGION = "cn";
const ISSUER = "https://mcpcn.coros.com";
const MCP_URL = `${ISSUER}/mcp`;
const STATE_ROOT = process.env.MCP_CACHE_ROOT ?? path.join(homedir(), ".coros-mcp-skill-gateway-ts");
const TOKEN_PATH = process.env.MCP_CACHE_PATH ?? path.join(STATE_ROOT, REGION, "token.json");
const CLIENT_NAME = "COROS MCP Gateway CLI";

function nowEpoch() { return Math.floor(Date.now() / 1000); }
function isRecord(v) { return typeof v === "object" && v !== null && !Array.isArray(v); }
function isExpired(t, skew = 60) { return nowEpoch() + skew >= t.expires_at_epoch; }

class HttpClient {
  cookies = new Map();
  async request(method, url, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    let body;
    if (options.form) {
      body = new URLSearchParams(options.form).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    if (options.jsonBody !== undefined) {
      body = JSON.stringify(options.jsonBody);
      headers["Content-Type"] = "application/json";
    }
    if (this.cookies.size > 0) {
      headers.Cookie = Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const resp = await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    });
    const getSetCookie = resp.headers.getSetCookie;
    const rawCookies = typeof getSetCookie === "function" ? getSetCookie.call(resp.headers) : [];
    for (const rawCookie of rawCookies) {
      const [nameValue] = rawCookie.split(";");
      const sep = nameValue.indexOf("=");
      if (sep > 0) this.cookies.set(nameValue.slice(0, sep).trim(), nameValue.slice(sep + 1).trim());
    }
    return resp;
  }
  async readJson(resp) {
    const raw = await resp.text();
    if (!raw) return {};
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      const payloads = [];
      let cur = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line) { if (cur.length) { payloads.push(cur.join("\n")); cur = []; } continue; }
        if (line.startsWith("data:")) cur.push(line.slice(5).trimStart());
      }
      if (payloads.length === 0) return {};
      return JSON.parse(payloads[payloads.length - 1]);
    }
    return JSON.parse(raw);
  }
}

const http = new HttpClient();

function loadToken() {
  try { return JSON.parse(readFileSync(TOKEN_PATH, "utf8")); }
  catch { return undefined; }
}

async function registerClient() {
  const resp = await http.request("POST", `${ISSUER}/connect/register`, {
    jsonBody: {
      client_name: CLIENT_NAME,
      redirect_uris: ["http://127.0.0.1:43123/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "openid offline_access mcp.tools",
      token_endpoint_auth_method: "none",
    },
  });
  const payload = await http.readJson(resp);
  if (resp.status !== 200 && resp.status !== 201) throw new Error(`client register failed: ${JSON.stringify(payload)}`);
  return payload.client_id;
}

async function refresh(tokenSet) {
  const clientId = tokenSet.client_id ?? await registerClient();
  const resp = await http.request("POST", `${ISSUER}/oauth2/token`, {
    form: {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokenSet.refresh_token,
    },
  });
  const payload = await http.readJson(resp);
  if (resp.status !== 200) throw new Error(`token refresh failed: ${JSON.stringify(payload)}`);
  const out = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at_epoch: nowEpoch() + Number(payload.expires_in ?? 3600),
    token_type: String(payload.token_type ?? "Bearer"),
    scope: String(payload.scope ?? "openid offline_access mcp.tools"),
    client_id: clientId,
  };
  writeFileSync(TOKEN_PATH, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  return out;
}

async function ensureToken() {
  let t = loadToken();
  if (!t) throw new Error("no token cache found; run coros-mcp login first");
  if (isExpired(t)) t = await refresh(t);
  return t;
}

function authHeader(t) { return `${t.token_type} ${t.access_token}`; }

async function mcpRequest(t, id, method, params) {
  const resp = await http.request("POST", MCP_URL, {
    headers: { Authorization: authHeader(t), Accept: "application/json, text/event-stream" },
    jsonBody: { jsonrpc: "2.0", id, method, params },
  });
  const payload = await http.readJson(resp);
  if (resp.status !== 200) throw new Error(`mcp ${method} failed: ${JSON.stringify(payload)}`);
  if ("error" in payload) throw new Error(`mcp ${method} error: ${JSON.stringify(payload.error)}`);
  return payload;
}

async function initialize() {
  const t = await ensureToken();
  await mcpRequest(t, 1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
  });
  return t;
}

async function listTools() {
  const t = await initialize();
  const tools = [];
  let cursor;
  let id = 2;
  while (true) {
    const r = await mcpRequest(t, id, "tools/list", cursor ? { cursor } : {});
    if (!isRecord(r.result) || !Array.isArray(r.result.tools)) throw new Error("tools/list missing tools");
    tools.push(...r.result.tools.filter(isRecord));
    cursor = typeof r.result.nextCursor === "string" && r.result.nextCursor ? r.result.nextCursor : undefined;
    if (!cursor) break;
    id += 1;
  }
  return tools;
}

async function callTool(name, args) {
  const t = await initialize();
  const r = await mcpRequest(t, 2, "tools/call", { name, arguments: args });
  if (!isRecord(r.result)) throw new Error(`tools/call for ${name} missing result`);
  return r.result;
}

function parseArgs(argv) {
  const a = { tool: undefined, argsFile: undefined, listTools: false, outFile: undefined };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--tool") a.tool = argv[++i];
    else if (v === "--args-file") a.argsFile = argv[++i];
    else if (v === "--out-file") a.outFile = argv[++i];
    else if (v === "--list-tools") a.listTools = true;
    else if (v === "--help" || v === "-h") a.help = true;
    else throw new Error(`unknown argument: ${v}`);
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || (!a.tool && !a.listTools)) {
    console.log("usage: node tools/coros_mcp.mjs --tool <name> [--args-file <json>] [--out-file <json>]");
    console.log("       node tools/coros_mcp.mjs --list-tools");
    return 0;
  }
  if (a.listTools) {
    const tools = await listTools();
    console.log(JSON.stringify(tools, null, 2));
    return 0;
  }
  let args = {};
  if (a.argsFile) args = JSON.parse(readFileSync(path.resolve(__dirname, a.argsFile), "utf8"));
  const result = await callTool(a.tool, args);
  const out = JSON.stringify(result, null, 2);
  if (a.outFile) writeFileSync(path.resolve(__dirname, a.outFile), out + "\n", "utf8");
  else console.log(out);
  return 0;
}

process.exitCode = await main().catch((e) => { console.error("error:", e.message); return 1; });
