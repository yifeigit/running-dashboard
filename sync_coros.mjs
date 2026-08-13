#!/usr/bin/env node
// One-shot COROS sync pipeline:
//   1. Pull the full sport-record list from COROS MCP (all sports, all time).
//   2. Compare against local fit/*.fit and download any missing FIT files.
//   3. Re-parse FIT (fitdecode) and TCX (Xiaomi) files.
//   4. Re-integrate everything into activities.json / activities.csv.
//
// Usage: node sync_coros.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIT_DIR = path.join(__dirname, "fit");
const TCX_DIR = path.join(__dirname, "tcx");
const TOOLS_DIR = path.join(__dirname, "tools");
const REGION = "cn";
const ISSUER = "https://mcpcn.coros.com";
const MCP_URL = `${ISSUER}/mcp`;
const STATE_ROOT = path.join(homedir(), ".coros-mcp-skill-gateway-ts");
const TOKEN_PATH = path.join(STATE_ROOT, REGION, "token.json");
const CLIENT_NAME = "COROS MCP Gateway CLI";

const log = (...a) => console.log("[sync]", ...a);
const nowEpoch = () => Math.floor(Date.now() / 1000);
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------- HTTP + MCP client ----------
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
    const resp = await fetch(url, { method, headers, body, redirect: "manual" });
    const getSetCookie = resp.headers.getSetCookie;
    const rawCookies = typeof getSetCookie === "function" ? getSetCookie.call(resp.headers) : [];
    for (const rawCookie of rawCookies) {
      const [nv] = rawCookie.split(";");
      const sep = nv.indexOf("=");
      if (sep > 0) this.cookies.set(nv.slice(0, sep).trim(), nv.slice(sep + 1).trim());
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
      return payloads.length ? JSON.parse(payloads[payloads.length - 1]) : {};
    }
    return JSON.parse(raw);
  }
}
const http = new HttpClient();

function loadToken() {
  try { return JSON.parse(readFileSync(TOKEN_PATH, "utf8")); } catch { return undefined; }
}
function isExpired(t, skew = 60) { return nowEpoch() + skew >= t.expires_at_epoch; }
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
async function refresh(t) {
  const clientId = t.client_id ?? await registerClient();
  const resp = await http.request("POST", `${ISSUER}/oauth2/token`, {
    form: { grant_type: "refresh_token", client_id: clientId, refresh_token: t.refresh_token },
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
const authHeader = (t) => `${t.token_type} ${t.access_token}`;
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
async function callTool(name, args) {
  const t = await ensureToken();
  await mcpRequest(t, 1, "initialize", {
    protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
  });
  const r = await mcpRequest(t, 2, "tools/call", { name, arguments: args });
  return r.result;
}
function toolText(result) {
  const item = (result?.content ?? []).find((c) => c.type === "text");
  if (!item) throw new Error("tool result has no text content");
  let txt = item.text;
  try { txt = JSON.parse(txt); } catch { /* already plain */ }
  return txt;
}

// ---------- querySportRecords text parsing ----------
function parseRecordsText(body) {
  const records = [];
  const lines = body.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const m = line.match(/^(\d+)\.\s*(.+?)\s*—\s*(\d{4}-\d{2}-\d{2})\s*$/);
    if (m) {
      if (current) records.push(current);
      current = { sport: m[2].trim(), date: m[3], raw: {} };
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^\s{0,4}(Location|Start Coordinates|Time Window|Duration|Average Pace|LabelId):\s*(.*)$/);
    if (kv) current.raw[kv[1]] = kv[2].trim();
  }
  if (current) records.push(current);

  const parseDuration = (s) => {
    const p = s.split(":").map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : 0;
  };
  const parsePace = (s) => { const p = s.split(":").map(Number); return p[0] * 60 + (p[1] ?? 0); };

  return records.map((r) => {
    const tm = (r.raw["Time Window"] ?? "").match(/startTimestamp=(\d+) \| endTimestamp=(\d+)/);
    const dur = (r.raw["Duration"] ?? "").match(/^([\d:]+) \| Distance: ([\d.]+) km$/);
    const pace = (r.raw["Average Pace"] ?? "").match(/^([\d:]+) \/km \| Avg HR: (\d+) bpm \| Calories: (\d+) kcal$/);
    const label = (r.raw["LabelId"] ?? "").match(/^(\d+) \| SportType: (\d+)$/);
    const coord = (r.raw["Start Coordinates"] ?? "").match(/(-?[\d.]+),\s*(-?[\d.]+)/);
    return {
      date: r.date, sport: r.sport, location: r.raw["Location"] ?? "",
      startLat: coord ? Number(coord[1]) : null, startLon: coord ? Number(coord[2]) : null,
      startTimestamp: tm ? Number(tm[1]) : null, endTimestamp: tm ? Number(tm[2]) : null,
      durationSeconds: dur ? parseDuration(dur[1]) : 0, distanceKm: dur ? Number(dur[2]) : 0,
      avgPaceSecPerKm: pace ? parsePace(pace[1]) : null,
      avgHeartRate: pace ? Number(pace[2]) : null, calories: pace ? Number(pace[3]) : null,
      labelId: label ? label[1] : null, sportType: label ? Number(label[2]) : null,
    };
  });
}

// ---------- integration (inline) ----------
function secToKmPace(seconds, km) {
  return km && km > 0 ? Math.round((seconds / km) * 10) / 10 : null;
}
function integrate(records, fitParsed, tcxParsed) {
  const corosById = new Map(records.map((r) => [r.labelId, r]));
  const fitByFile = new Map(fitParsed.activities.map((a) => [a.file, a]));
  const activities = [];
  for (const rec of records) {
    const session = fitByFile.get(`${rec.labelId}.fit`)?.session ?? {};
    activities.push({
      source: "coros", date: rec.date,
      startTimeUtc: rec.startTimestamp ? new Date(rec.startTimestamp * 1000).toISOString() : null,
      endTimeUtc: rec.endTimestamp ? new Date(rec.endTimestamp * 1000).toISOString() : null,
      durationSeconds: rec.durationSeconds || session.total_elapsed_time || null,
      distanceKm: rec.distanceKm,
      avgPaceSecPerKm: rec.avgPaceSecPerKm ?? secToKmPace(rec.durationSeconds, rec.distanceKm),
      avgHeartRate: rec.avgHeartRate ?? session.avg_heart_rate ?? null,
      maxHeartRate: session.max_heart_rate ?? null,
      calories: rec.calories ?? session.total_calories ?? null,
      location: rec.location || null, startLat: rec.startLat, startLon: rec.startLon,
      labelId: rec.labelId, sportType: rec.sportType,
      totalAscentM: session.total_ascent ?? null, totalDescentM: session.total_descent ?? null,
      avgPower: session.avg_power ?? null, steps: null, file: `${rec.labelId}.fit`,
    });
  }
  for (const item of tcxParsed.activities) {
    const act = item.activities[0];
    if (!act) continue;
    const dm = item.file.match(/^(\d{4})(\d{2})(\d{2})/);
    const date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;
    const distanceKm = act.distanceMeters ? Math.round((act.distanceMeters / 1000) * 100) / 100 : null;
    activities.push({
      source: "xiaomi", date,
      startTimeUtc: act.startTime ?? act.id, endTimeUtc: act.endTime ?? null,
      durationSeconds: act.durationSeconds, distanceKm,
      avgPaceSecPerKm: secToKmPace(act.durationSeconds, distanceKm),
      avgHeartRate: act.avgHeartRate ?? null, maxHeartRate: null,
      calories: act.calories || null, location: null, startLat: null, startLon: null,
      labelId: null, sportType: null, totalAscentM: null, totalDescentM: null,
      avgPower: null, steps: act.steps || null, file: item.file,
    });
  }
  activities.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : (a.startTimeUtc ?? "") < (b.startTimeUtc ?? "") ? -1 : 1));

  const headers = ["date", "source", "startTimeUtc", "durationSeconds", "distanceKm", "avgPaceSecPerKm", "avgHeartRate", "maxHeartRate", "calories", "location", "labelId", "file"];
  const esc = (v) => (v === null || v === undefined) ? "" : (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [headers.join(","), ...activities.map((a) => headers.map((h) => esc(a[h])).join(","))].join("\n") + "\n";

  writeFileSync(path.join(__dirname, "activities.json"), JSON.stringify(activities, null, 2) + "\n", "utf8");
  writeFileSync(path.join(__dirname, "activities.csv"), csv, "utf8");

  const bySource = activities.reduce((a, x) => ((a[x.source] = (a[x.source] ?? 0) + 1), a), {});
  const corosDates = new Set(activities.filter((a) => a.source === "coros").map((a) => a.date));
  const xiaomiDates = new Set(activities.filter((a) => a.source === "xiaomi").map((a) => a.date));
  writeFileSync(path.join(__dirname, "summary.json"), JSON.stringify({
    totalActivities: activities.length,
    bySource,
    dateRange: activities.length ? [activities[0].date, activities[activities.length - 1].date] : null,
    overlapDates: [...corosDates].filter((d) => xiaomiDates.has(d)),
  }, null, 2) + "\n", "utf8");
  return activities;
}

function runPython(script, args) {
  const r = spawnSync("python", [script, ...args], { stdio: "inherit", encoding: "utf8" });
  if (r.error) throw new Error(`failed to run python: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`python ${path.basename(script)} exited ${r.status}`);
}

// ---------- main ----------
async function main() {
  // 1. Pull records
  const endDate = (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  })();
  log("querying COROS sport records ...");
  const result = await callTool("querySportRecords", {
    // 仅跑步：100 户外跑 / 101 室内跑 / 102 越野跑 / 103 跑道跑（排除徒步 104、爬山 105、体能训练等）
    startDate: "20200101", endDate, sportTypeCodes: [100, 101, 102, 103], limit: 5000,
  });
  const records = parseRecordsText(toolText(result));
  log(`got ${records.length} records from COROS`);

  // 2. Compare local fit, download missing
  const localIds = new Set((readdirSync(FIT_DIR) ?? []).filter((f) => f.toLowerCase().endsWith(".fit")).map((f) => f.replace(/\.fit$/i, "")));
  const missing = records.filter((r) => r.labelId && !localIds.has(r.labelId));
  log(`local fit: ${localIds.size}, missing to download: ${missing.length}`);
  for (const rec of missing) {
    const r = await callTool("queryActivityFitFileDownloadUrls", { labelId: rec.labelId, sportType: rec.sportType });
    const txt = toolText(r);
    const url = (txt.match(/https?:\/\/\S+\.fit/) ?? [])[0];
    if (!url) throw new Error(`no download url for ${rec.labelId}`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`download ${rec.labelId} HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const dest = path.join(FIT_DIR, `${rec.labelId}.fit`);
    writeFileSync(dest, buf);
    log(`downloaded ${rec.labelId}.fit (${buf.byteLength} bytes) ${rec.date} ${rec.distanceKm}km`);
  }

  // 3. Save record list + re-parse local files
  writeFileSync(path.join(TOOLS_DIR, "coros_records_parsed.json"), JSON.stringify(records, null, 2) + "\n", "utf8");
  log("parsing FIT files ...");
  runPython(path.join(TOOLS_DIR, "parse_fit.py"), [FIT_DIR, path.join(TOOLS_DIR, "fit_parsed.json")]);
  log("parsing TCX files ...");
  runPython(path.join(TOOLS_DIR, "parse_tcx.py"), [TCX_DIR, path.join(TOOLS_DIR, "tcx_parsed.json")]);

  // 4. Integrate
  const fitParsed = JSON.parse(readFileSync(path.join(TOOLS_DIR, "fit_parsed.json"), "utf8"));
  const tcxParsed = JSON.parse(readFileSync(path.join(TOOLS_DIR, "tcx_parsed.json"), "utf8"));
  const activities = integrate(records, fitParsed, tcxParsed);
  const bySource = activities.reduce((a, x) => ((a[x.source] = (a[x.source] ?? 0) + 1), a), {});
  log(`integrated ${activities.length} activities ${JSON.stringify(bySource)} -> activities.json / activities.csv`);

  // 5. Extract GPS tracks + fetch health metrics + regenerate front-end data bundle
  log("extracting GPS tracks ...");
  runPython(path.join(TOOLS_DIR, "extract_tracks.py"), [TCX_DIR, FIT_DIR, path.join(TOOLS_DIR, "tracks.json")]);

  log("fetching health metrics ...");
  const hf = spawnSync("node", [path.join(TOOLS_DIR, "fetch_health.mjs"), path.join(TOOLS_DIR, "health_raw.json")], { stdio: "inherit", encoding: "utf8" });
  if (hf.error || hf.status !== 0) throw new Error("fetch_health.mjs failed");
  const hp = spawnSync("node", [path.join(TOOLS_DIR, "parse_health.mjs"), path.join(TOOLS_DIR, "health_raw.json"), path.join(TOOLS_DIR, "health.json")], { stdio: "inherit", encoding: "utf8" });
  if (hp.error || hp.status !== 0) throw new Error("parse_health.mjs failed");

  log("regenerating data.js ...");
  const gen = spawnSync("node", [path.join(TOOLS_DIR, "generate_data.mjs"), __dirname], { stdio: "inherit", encoding: "utf8" });
  if (gen.error || gen.status !== 0) throw new Error("generate_data.mjs failed");
  log("DONE");
}

await main().catch((e) => { console.error("[sync] error:", e.message); process.exit(1); });
