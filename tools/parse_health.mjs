#!/usr/bin/env node
// Parse health_raw.json (COROS MCP text payloads) into structured health.json.
import { readFileSync, writeFileSync } from "node:fs";

const raw = JSON.parse(readFileSync(process.argv[2], "utf8"));
const outFile = process.argv[3];
const T = (name) => (raw[name]?.text ?? "") || "";

function parseHM(s) {
  let total = 0;
  const h = s.match(/(\d+)\s*h/);
  const m = s.match(/(\d+)\s*min/);
  if (h) total += Number(h[1]) * 60;
  if (m) total += Number(m[1]);
  return total;
}

function parseFitness(t) {
  const get = (re) => (t.match(re) ?? [])[1];
  return {
    vo2max: Number(get(/VO2max:\s*(\d+)/)),
    runningLevel: Number(get(/Running Level:\s*(\d+)/)),
    thresholdPace: get(/Threshold Pace:\s*([\d:]+)/),
    predictions: {
      "5k": get(/5 km Prediction:\s*([\d:]+)/),
      "10k": get(/10 km Prediction:\s*([\d:]+)/),
      half: get(/Half Marathon Prediction:\s*([\d:]+)/),
      marathon: get(/(?<!Half )Marathon Prediction:\s*([\d:]+)/),
    },
  };
}

function parseRecovery(t) {
  return {
    recovery: get0(t.match(/Recovery:\s*(\d+)%/)),
    level: get0(t.match(/Level:\s*([^\n]+)/)),
    fullRecovery: get0(t.match(/Estimated Full Recovery:\s*([^\n]+)/)),
  };
}
function get0(m) { return m ? m[1] : null; }

function parseTrainingLoad(t) {
  const out = [];
  const blocks = t.split(/\n(?=\d{4}-\d{2}-\d{2}\n)/);
  for (const b of blocks) {
    const date = (b.match(/^(\d{4}-\d{2}-\d{2})/m) ?? [])[1];
    if (!date) continue;
    const g = (re) => (b.match(re) ?? [])[1];
    out.push({
      date,
      comment: g(/Comment:\s*(\w+)/),
      shortLoad: g(/Short-Term Load:\s*([\d.]+)/),
      longLoad: g(/Long-Term Load:\s*([\d.]+)/),
      ratio: g(/Load Ratio:\s*([\d.]+)/),
    });
  }
  return out;
}

function parseHrv(t) {
  const out = [];
  const re = /(\d{4}-\d{2}-\d{2}):\s*\n\s*HRV Avg:\s*(\d+)\s*ms[^\n]*\n\s*Normal Range:\s*(\d+)\s*-\s*(\d+)\s*ms\n\s*Baseline:\s*(\d+)\s*ms/g;
  let m;
  while ((m = re.exec(t))) {
    out.push({ date: m[1], avg: Number(m[2]), normalMin: Number(m[3]), normalMax: Number(m[4]), baseline: Number(m[5]) });
  }
  return out;
}

function parseDailySeries(t, re) {
  const out = [];
  let m;
  while ((m = re.exec(t))) out.push({ date: m[1], value: Number(m[2]) });
  return out;
}

function parseRestingHR(t) {
  return parseDailySeries(t, /(\d{4}-\d{2}-\d{2}):\s*(\d+)\s*bpm/g).map((o) => ({ ...o, bpm: o.value }));
}

function parseAvgHR(t) {
  const out = [];
  const re = /(\d{4}-\d{2}-\d{2}):\s*(\d+)\s*bpm \(Min:\s*(\d+),\s*Max:\s*(\d+)\)/g;
  let m;
  while ((m = re.exec(t))) out.push({ date: m[1], avg: Number(m[2]), min: Number(m[3]), max: Number(m[4]) });
  return out;
}

function parseStress(t) {
  const out = [];
  const re = /(\d{4}-\d{2}-\d{2}):\s*\nAverage Stress:\s*(\d+)\s*\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(t))) out.push({ date: m[1], avg: Number(m[2]), level: m[3] });
  return out;
}

function parseSleep(t) {
  const out = [];
  const blocks = t.split(/\n(?=\d{4}-\d{2}-\d{2}\n)/);
  for (const b of blocks) {
    const date = (b.match(/^(\d{4}-\d{2}-\d{2})/m) ?? [])[1];
    if (!date) continue;
    const g = (re) => (b.match(re) ?? [])[1];
    const mainSleep = g(/Main Sleep:\s*([^\n]+)/);
    const ratio = (re) => { const v = g(re); return v ? Number(v) : null; };
    out.push({
      date,
      score: g(/Sleep Score:\s*(\d+)/),
      totalMinutes: mainSleep ? parseHM(mainSleep) : null,
      deepRatio: ratio(/Deep Sleep Ratio:\s*(\d+)%/),
      lightRatio: ratio(/Light Sleep Ratio:\s*(\d+)%/),
      remRatio: ratio(/REM Ratio:\s*(\d+)%/),
      awakeRatio: ratio(/Awake Ratio:\s*(\d+)%/),
    });
  }
  return out;
}

function parseDailyHealth(t) {
  const out = [];
  const re = /--- (\d{8}) ---\s*\nSteps:\s*([\d,]+) \| Calories:\s*([\d,]+) kcal \| Exercise:\s*([\d]+) min \| Floors:\s*(\d+)\s*\nStress:\s*Avg (\d+)/g;
  let m;
  while ((m = re.exec(t))) {
    out.push({
      date: `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`,
      steps: Number(m[2].replace(/,/g, "")),
      calories: Number(m[3]),
      exerciseMin: Number(m[4]),
      floors: Number(m[5]),
      stress: Number(m[6]),
    });
  }
  return out;
}

function parseDevices(t) {
  const out = [];
  const re = /\d+\.\s*([^\n]+)\n(?:[\s\S]*?Model Name:\s*([^\n]+))?/g;
  let m;
  while ((m = re.exec(t))) out.push({ name: m[1].trim(), model: m[2] ? m[2].trim() : null });
  return out;
}

const health = {
  fitness: parseFitness(T("queryFitnessAssessmentOverview")),
  recovery: parseRecovery(T("queryRecoveryStatus")),
  trainingLoad: parseTrainingLoad(T("queryTrainingLoadAssessment")),
  hrv: parseHrv(T("querySleepHrv")),
  restingHR: parseRestingHR(T("queryRestingHeartRate")),
  avgHR: parseAvgHR(T("queryAvgHeartRate")),
  stress: parseStress(T("queryStressLevel")),
  sleep: parseSleep(T("querySleepData")),
  dailyHealth: parseDailyHealth(T("queryDailyHealthData")),
  devices: parseDevices(T("queryDevices")),
};

writeFileSync(outFile, JSON.stringify(health, null, 2) + "\n", "utf8");
const counts = Object.fromEntries(Object.entries(health).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v]));
console.log("parsed health ->", outFile);
console.log(JSON.stringify(counts));
