#!/usr/bin/env node
// Parse the text payload returned by querySportRecords into structured JSON.
import { readFileSync, writeFileSync } from "node:fs";

const inFile = process.argv[2];
const outFile = process.argv[3];

const raw = JSON.parse(readFileSync(inFile, "utf8"));
const text = raw.content[0].text; // the text is itself a JSON string

// The text field is a double-encoded string like "\"Sport Records — ...\""
let body = text;
try { body = JSON.parse(text); } catch { /* already plain */ }

const records = [];
const blockRe = /^(\d+)\.\s*(.+?)\s*—\s*(\d{4}-\d{2}-\d{2})\s*$/gm;
// Split into per-record blocks by matching the numbered headers.
const lines = body.split(/\r?\n/);

let current = null;
for (const line of lines) {
  const m = line.match(/^(\d+)\.\s*(.+?)\s*—\s*(\d{4}-\d{2}-\d{2})\s*$/);
  if (m) {
    if (current) records.push(current);
    current = {
      index: Number(m[1]),
      sport: m[2].trim(),
      date: m[3],
      raw: {},
    };
    continue;
  }
  if (!current) continue;
  const kv = line.match(/^\s{0,4}(Location|Start Coordinates|Time Window|Duration|Average Pace|LabelId):\s*(.*)$/);
  if (kv) current.raw[kv[1]] = kv[2].trim();
}

if (current) records.push(current);

function parseDuration(s) {
  const parts = s.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}
function parsePace(s) {
  const parts = s.split(":").map(Number);
  return parts[0] * 60 + (parts[1] ?? 0);
}

const out = records.map((r) => {
  const timeWindow = r.raw["Time Window"] ?? "";
  const tm = timeWindow.match(/startTimestamp=(\d+) \| endTimestamp=(\d+)/);
  const durM = (r.raw["Duration"] ?? "").match(/^([\d:]+) \| Distance: ([\d.]+) km$/);
  const paceM = (r.raw["Average Pace"] ?? "").match(/^([\d:]+) \/km \| Avg HR: (\d+) bpm \| Calories: (\d+) kcal$/);
  const labelM = (r.raw["LabelId"] ?? "").match(/^(\d+) \| SportType: (\d+)$/);
  return {
    date: r.date,
    sport: r.sport,
    location: r.raw["Location"] ?? "",
    startLat: null,
    startLon: null,
    startTimestamp: tm ? Number(tm[1]) : null,
    endTimestamp: tm ? Number(tm[2]) : null,
    durationSeconds: durM ? parseDuration(durM[1]) : 0,
    distanceKm: durM ? Number(durM[2]) : 0,
    avgPaceSecPerKm: paceM ? parsePace(paceM[1]) : null,
    avgHeartRate: paceM ? Number(paceM[2]) : null,
    calories: paceM ? Number(paceM[3]) : null,
    labelId: labelM ? labelM[1] : null,
    sportType: labelM ? Number(labelM[2]) : null,
  };
});

// Coordinates are in a separate "Start Coordinates" field.
for (const r of out) {
  const coordRaw = records.find((x) => x.date === r.date && x.raw["LabelId"]?.includes(r.labelId ?? ""))?.raw["Start Coordinates"] ?? "";
  const cm = coordRaw.match(/(-?[\d.]+),\s*(-?[\d.]+)/);
  if (cm) { r.startLat = Number(cm[1]); r.startLon = Number(cm[2]); }
}

writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`parsed ${out.length} records -> ${outFile}`);
