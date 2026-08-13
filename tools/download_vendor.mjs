#!/usr/bin/env node
// Download ECharts + Leaflet (and its images) locally so the page works
// without foreign CDNs (important for viewers in mainland China).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] ?? ".";
const files = [
  ["vendor/echarts.min.js", "https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"],
  ["vendor/leaflet/leaflet.js", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"],
  ["vendor/leaflet/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"],
  ["vendor/leaflet/images/layers.png", "https://unpkg.com/leaflet@1.9.4/dist/images/layers.png"],
  ["vendor/leaflet/images/layers-2x.png", "https://unpkg.com/leaflet@1.9.4/dist/images/layers-2x.png"],
  ["vendor/leaflet/images/marker-icon.png", "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png"],
  ["vendor/leaflet/images/marker-icon-2x.png", "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png"],
  ["vendor/leaflet/images/marker-shadow.png", "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png"],
];

for (const [rel, url] of files) {
  const dest = path.join(ROOT, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(dest, buf);
  console.log(`OK ${rel} (${(buf.byteLength / 1024).toFixed(1)} KB)`);
}
console.log("DONE");
