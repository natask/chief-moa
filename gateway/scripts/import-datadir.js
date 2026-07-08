#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const { createRelationalStore } = require("../lib/relational-store");

const TARGETS = [
  { key: "conversations", dir: "conversations", method: "upsertChatTurn" },
  { key: "voice_turns", dir: "voice-turns", method: "upsertVoiceTurn" },
  { key: "agent_runs", dir: "agent-runs", method: "upsertAgentRun", ignore: (filePath) => filePath.endsWith(".events.json") },
  { key: "browser_tasks", dir: "browser-tasks", method: "upsertBrowserTask" },
  { key: "tool_requests", dir: "tool-requests", method: "upsertToolRequest" },
];

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to import DATA_DIR into the relational store");
  }

  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, "..", "data"));
  const pool = new Pool({ connectionString: databaseUrl });
  const store = createRelationalStore({
    pool,
    originId: process.env.MOA_ORIGIN_ID || process.env.GATEWAY_ORIGIN_ID || "datadir-importer",
  });

  try {
    const summary = await importDataDir({ dataDir, store });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await pool.end();
  }
}

async function importDataDir({ dataDir, store }) {
  const summary = { data_dir: dataDir };
  for (const target of TARGETS) {
    const dir = path.join(dataDir, target.dir);
    const files = listJsonFiles(dir).filter((filePath) => !target.ignore?.(filePath));
    const counts = { files: files.length, rows: 0, events: 0 };
    for (const filePath of files) {
      const record = readJsonFile(filePath);
      const result = await store[target.method](record);
      if (result.rowInserted) counts.rows += 1;
      if (result.eventInserted) counts.events += 1;
    }
    summary[target.key] = counts;
  }
  return summary;
}

function parseArgs(args) {
  const options = { dataDir: "" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--data-dir") {
      options.dataDir = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--data-dir=")) {
      options.dataDir = arg.slice("--data-dir=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: DATABASE_URL=postgres://... node scripts/import-datadir.js [--data-dir=/path/to/data]");
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return [];
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    const filePath = path.join(dir, name);
    const itemStat = fs.statSync(filePath);
    if (itemStat.isDirectory()) {
      files.push(...listJsonFiles(filePath));
    } else if (itemStat.isFile() && name.endsWith(".json")) {
      files.push(filePath);
    }
  }
  return files.sort();
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${filePath}: ${error.message}`);
  }
}

module.exports = {
  importDataDir,
  parseArgs,
};
