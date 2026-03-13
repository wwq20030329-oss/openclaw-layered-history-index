#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

async function collectTraceFiles(targetPath) {
  const resolved = path.resolve(targetPath || ".");
  const stat = await fsp.stat(resolved);
  if (stat.isFile()) {
    return [resolved];
  }
  const files = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "route-trace.jsonl") {
        files.push(fullPath);
      }
    }
  }
  await walk(resolved);
  return files.sort();
}

function parseTraceLines(text, filePath) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON in ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function classifyEntry(entry) {
  if (entry?.resolved?.loadedL2) {
    return "L2";
  }
  if (entry?.resolved?.loadedL1) {
    return "L1";
  }
  if (entry?.resolved?.loadedL0) {
    return "L0";
  }
  return "none";
}

function addToBucket(map, key, entry) {
  if (!map.has(key)) {
    map.set(key, {
      count: 0,
      actualTokens: 0,
      baselineTokens: 0,
      savedTokens: 0,
    });
  }
  const bucket = map.get(key);
  const metrics = entry.metrics || {};
  bucket.count += 1;
  bucket.actualTokens += metrics.actual?.total?.tokens || 0;
  bucket.baselineTokens += metrics.baseline?.total?.tokens || 0;
  bucket.savedTokens += metrics.saved?.tokens || 0;
}

async function main() {
  const targetPath = process.argv[2];
  if (!targetPath) {
    console.error("Usage: node scripts/analyze-route-trace.cjs <route-trace.jsonl|directory>");
    process.exitCode = 1;
    return;
  }

  const files = await collectTraceFiles(targetPath);
  if (files.length === 0) {
    console.error("No route-trace.jsonl files found.");
    process.exitCode = 1;
    return;
  }

  const entries = [];
  for (const filePath of files) {
    const text = await fsp.readFile(filePath, "utf8");
    const parsed = parseTraceLines(text, filePath).map((entry) => ({ ...entry, __file: filePath }));
    entries.push(...parsed);
  }

  if (entries.length === 0) {
    console.error("No route trace entries found.");
    process.exitCode = 1;
    return;
  }

  const totals = {
    actualTokens: 0,
    baselineTokens: 0,
    savedTokens: 0,
  };
  const buckets = new Map();
  const reasons = new Map();

  for (const entry of entries) {
    const metrics = entry.metrics || {};
    totals.actualTokens += metrics.actual?.total?.tokens || 0;
    totals.baselineTokens += metrics.baseline?.total?.tokens || 0;
    totals.savedTokens += metrics.saved?.tokens || 0;

    addToBucket(buckets, classifyEntry(entry), entry);
    const reason = String(entry?.route?.reason || "").trim();
    if (reason) {
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
  }

  const avgActual = totals.actualTokens / entries.length;
  const avgBaseline = totals.baselineTokens / entries.length;
  const avgSaved = totals.savedTokens / entries.length;
  const overallPercent =
    totals.baselineTokens > 0 ? (totals.savedTokens / totals.baselineTokens) * 100 : 0;

  console.log(`Trace files: ${files.length}`);
  console.log(`Recall entries: ${entries.length}`);
  console.log(`Actual injected tokens: ${formatNumber(totals.actualTokens)} total, ${avgActual.toFixed(1)} avg`);
  console.log(`Baseline tokens: ${formatNumber(totals.baselineTokens)} total, ${avgBaseline.toFixed(1)} avg`);
  console.log(`Saved vs baseline: ${formatNumber(totals.savedTokens)} total, ${avgSaved.toFixed(1)} avg, ${formatPercent(overallPercent)}`);

  console.log("");
  console.log("By recall tier:");
  for (const key of ["L0", "L1", "L2", "none"]) {
    const bucket = buckets.get(key);
    if (!bucket) {
      continue;
    }
    const percent =
      bucket.baselineTokens > 0 ? (bucket.savedTokens / bucket.baselineTokens) * 100 : 0;
    console.log(
      `- ${key}: ${bucket.count} entries, ${bucket.actualTokens} actual, ${bucket.baselineTokens} baseline, ${bucket.savedTokens} saved (${formatPercent(percent)})`,
    );
  }

  const topReasons = [...reasons.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5);
  if (topReasons.length > 0) {
    console.log("");
    console.log("Top route reasons:");
    for (const [reason, count] of topReasons) {
      console.log(`- ${reason}: ${count}`);
    }
  }

  console.log("");
  console.log("Files:");
  for (const filePath of files) {
    console.log(`- ${filePath}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
