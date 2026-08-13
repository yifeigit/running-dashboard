#!/usr/bin/env node
// Compare COROS records (labelId) against local .fit filenames.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const recordsFile = process.argv[2];
const fitDir = process.argv[3];
const outFile = process.argv[4];

const records = JSON.parse(readFileSync(recordsFile, "utf8"));
const localFiles = new Set(readdirSync(fitDir).filter((f) => f.toLowerCase().endsWith(".fit")));

const corosIds = new Set(records.map((r) => r.labelId).filter(Boolean));
const localIds = new Set([...localFiles].map((f) => f.replace(/\.fit$/i, "")));

const missingInLocal = [...corosIds].filter((id) => !localIds.has(id));
const extraInLocal = [...localIds].filter((id) => !corosIds.has(id));

const result = {
  corosRecordCount: records.length,
  localFitCount: localFiles.size,
  missingInLocal: missingInLocal.map((id) => records.find((r) => r.labelId === id)),
  extraInLocal,
};

writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(`coros records: ${records.length}`);
console.log(`local fit files: ${localFiles.size}`);
console.log(`missing in local (need download): ${missingInLocal.length}`);
console.log(`extra in local (not in coros): ${extraInLocal.length}`);
if (extraInLocal.length) console.log("extra ids:", extraInLocal.join(", "));
