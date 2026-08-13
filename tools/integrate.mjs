#!/usr/bin/env node
// Integrate Xiaomi (tcx) + COROS (fit + record list) into one unified running dataset.
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = process.argv[2] ?? ".";
const tcxParsed = JSON.parse(readFileSync(`${ROOT}/tools/tcx_parsed.json`, "utf8"));
const fitParsed = JSON.parse(readFileSync(`${ROOT}/tools/fit_parsed.json`, "utf8"));
const corosRecords = JSON.parse(readFileSync(`${ROOT}/tools/coros_records_parsed.json`, "utf8"));

// COROS records indexed by labelId; FIT indexed by filename (=labelId).
const corosById = new Map(corosRecords.map((r) => [r.labelId, r]));
const fitByFile = new Map(fitParsed.activities.map((a) => [a.file, a]));

function secToKmPace(seconds, km) {
  if (!km || km <= 0) return null;
  return Math.round((seconds / km) * 10) / 10;
}

const activities = [];

// ---- COROS (fit + record list) ----
for (const rec of corosRecords) {
  const fit = fitByFile.get(`${rec.labelId}.fit`) ?? null;
  const session = fit?.session ?? {};
  activities.push({
    source: "coros",
    date: rec.date,
    startTimeUtc: rec.startTimestamp ? new Date(rec.startTimestamp * 1000).toISOString() : null,
    endTimeUtc: rec.endTimestamp ? new Date(rec.endTimestamp * 1000).toISOString() : null,
    durationSeconds: rec.durationSeconds || (session.total_elapsed_time ?? null),
    distanceKm: rec.distanceKm,
    avgPaceSecPerKm: rec.avgPaceSecPerKm ?? secToKmPace(rec.durationSeconds, rec.distanceKm),
    avgHeartRate: rec.avgHeartRate ?? (session.avg_heart_rate ?? null),
    maxHeartRate: session.max_heart_rate ?? null,
    calories: rec.calories ?? (session.total_calories ?? null),
    location: rec.location || null,
    startLat: rec.startLat,
    startLon: rec.startLon,
    labelId: rec.labelId,
    sportType: rec.sportType,
    totalAscentM: session.total_ascent ?? null,
    totalDescentM: session.total_descent ?? null,
    avgPower: session.avg_power ?? null,
    steps: null,
    file: `${rec.labelId}.fit`,
  });
}

// ---- Xiaomi (tcx) ----
for (const item of tcxParsed.activities) {
  const act = item.activities[0];
  if (!act) continue;
  const dateMatch = item.file.match(/^(\d{4})(\d{2})(\d{2})/);
  const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null;
  const distanceKm = act.distanceMeters ? Math.round((act.distanceMeters / 1000) * 100) / 100 : null;
  activities.push({
    source: "xiaomi",
    date,
    startTimeUtc: act.startTime ?? act.id,
    endTimeUtc: act.endTime ?? null,
    durationSeconds: act.durationSeconds,
    distanceKm,
    avgPaceSecPerKm: secToKmPace(act.durationSeconds, distanceKm),
    avgHeartRate: act.avgHeartRate ?? null,
    maxHeartRate: null,
    calories: act.calories || null,
    location: null,
    startLat: null,
    startLon: null,
    labelId: null,
    sportType: null,
    totalAscentM: null,
    totalDescentM: null,
    avgPower: null,
    steps: act.steps || null,
    file: item.file,
  });
}

// Sort chronologically by date then start time.
activities.sort((a, b) => {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return (a.startTimeUtc ?? "") < (b.startTimeUtc ?? "") ? -1 : 1;
});

const bySource = activities.reduce((acc, a) => {
  acc[a.source] = (acc[a.source] ?? 0) + 1;
  return acc;
}, {});
const dateRange = activities.length
  ? [activities[0].date, activities[activities.length - 1].date]
  : null;

// Verify no duplicate dates between sources (sanity check).
const corosDates = new Set(activities.filter((a) => a.source === "coros").map((a) => a.date));
const xiaomiDates = new Set(activities.filter((a) => a.source === "xiaomi").map((a) => a.date));
let overlapDates = [...corosDates].filter((d) => xiaomiDates.has(d));

const summary = {
  totalActivities: activities.length,
  bySource,
  dateRange,
  overlapDates,
};

writeFileSync(`${ROOT}/activities.json`, JSON.stringify(activities, null, 2) + "\n", "utf8");
writeFileSync(`${ROOT}/summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

// CSV for easy review.
const headers = [
  "date", "source", "startTimeUtc", "durationSeconds", "distanceKm",
  "avgPaceSecPerKm", "avgHeartRate", "maxHeartRate", "calories", "location",
  "labelId", "file",
];
const esc = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rows = [headers.join(",")];
for (const a of activities) {
  rows.push(headers.map((h) => esc(a[h])).join(","));
}
writeFileSync(`${ROOT}/activities.csv`, rows.join("\n") + "\n", "utf8");

console.log(`integrated ${activities.length} activities -> activities.json / activities.csv`);
console.log(JSON.stringify(summary, null, 2));
