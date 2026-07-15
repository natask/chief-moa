#!/usr/bin/env node
"use strict";

// Backfill existing DATA_DIR media blobs (voice-turn PCM, audio notes, video
// notes) into the GCS bucket, idempotently. Sources are never modified unless
// --prune-verified is passed, and then only after the object's size matches.
//
// Usage (droplet):
//   docker compose ... exec gateway node scripts/backfill-blobs-to-gcs.js \
//     [--dry-run] [--verify] [--prune-verified] [--dir voice-sessions] \
//     [--concurrency 4]
//
// Env: DATA_DIR, GCS_BUCKET (required), GCS_PREFIX, GCS_PROJECT_ID, and the
// usual Google credential chain (GOOGLE_APPLICATION_CREDENTIALS / inline key).
// BLOB_STORE does not need to be set — this script talks to the bucket
// directly.

const fs = require("node:fs");
const path = require("node:path");
const { createGcsClient, contentTypeForKey } = require("../lib/blob-store");
const { createGoogleTokenSource } = require("../lib/google-auth");

const BLOB_DIRS = ["voice-sessions", "audio-notes", "video-notes"];
// Files younger than this may still be mid-write (a live voice turn).
const MIN_AGE_MS = 60 * 1000;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(process.env.DATA_DIR || "./data");
  const bucket = String(process.env.GCS_BUCKET || "").trim();
  if (!bucket) {
    console.error("GCS_BUCKET is required");
    process.exit(2);
  }
  const gcs = createGcsClient({
    bucket,
    prefix: String(process.env.GCS_PREFIX || "").trim(),
    endpoint: String(process.env.GCS_ENDPOINT || "").trim() || undefined,
    userProject: String(
      process.env.GCS_PROJECT_ID || process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "",
    ).trim(),
    tokenSource: createGoogleTokenSource({ env: process.env }),
  });

  const dirs = args.dir ? [args.dir] : BLOB_DIRS;
  const files = [];
  const now = Date.now();
  for (const dir of dirs) {
    for (const key of walk(path.join(dataDir, dir), dataDir)) {
      let stats;
      try {
        stats = fs.statSync(path.join(dataDir, key));
      } catch {
        continue;
      }
      if (!stats.isFile() || stats.size <= 0) continue;
      if (now - stats.mtimeMs < MIN_AGE_MS) {
        console.log(`skip (recent, may be mid-write): ${key}`);
        continue;
      }
      files.push({ key, size: stats.size });
    }
  }

  const summary = { scanned: files.length, uploaded: 0, skipped_existing: 0, missing: 0, pruned: 0, failed: 0 };
  const workers = [];
  const queue = [...files];
  const concurrency = Math.max(1, Math.min(16, Number(args.concurrency) || 4));
  for (let index = 0; index < concurrency; index += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const file = queue.shift();
          if (!file) return;
          try {
            await processFile(file);
          } catch (error) {
            summary.failed += 1;
            console.error(`FAIL ${file.key}: ${String(error?.message || error)}`);
          }
        }
      })(),
    );
  }
  await Promise.all(workers);

  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed > 0 || (args.verify && summary.missing > 0)) {
    process.exit(1);
  }

  async function processFile(file) {
    const remote = await gcs.stat(file.key);
    const matches = remote && remote.size === file.size;
    if (args.verify) {
      if (matches) {
        summary.skipped_existing += 1;
      } else {
        summary.missing += 1;
        console.log(`missing or size-mismatch in bucket: ${file.key} (local ${file.size}, remote ${remote ? remote.size : "absent"})`);
      }
      if (matches && args.pruneVerified && !args.dryRun) {
        fs.unlinkSync(path.join(dataDir, file.key));
        summary.pruned += 1;
        console.log(`pruned local (verified in bucket): ${file.key}`);
      }
      return;
    }
    if (matches) {
      summary.skipped_existing += 1;
      return;
    }
    if (args.dryRun) {
      summary.uploaded += 1;
      console.log(`would upload: ${file.key} (${file.size} bytes)`);
      return;
    }
    const bytes = fs.readFileSync(path.join(dataDir, file.key));
    // Create-only: a 412 means another run already uploaded it — fine. A
    // remote object with the WRONG size is left alone for manual inspection
    // rather than overwritten.
    const result = await gcs.upload(file.key, bytes, contentTypeForKey(file.key), { ifAbsent: true });
    if (result.existed) {
      summary.skipped_existing += 1;
    } else {
      summary.uploaded += 1;
      console.log(`uploaded: ${file.key} (${file.size} bytes)`);
    }
  }
}

function* walk(dir, root) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, root);
    } else if (entry.isFile() && !entry.name.endsWith(".json") && !entry.name.endsWith(".tmp")) {
      yield path.relative(root, full).split(path.sep).join("/");
    }
  }
}

function parseArgs(argv) {
  const args = { dryRun: false, verify: false, pruneVerified: false, dir: "", concurrency: 4 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") args.dryRun = true;
    else if (value === "--verify") args.verify = true;
    else if (value === "--prune-verified") {
      args.verify = true;
      args.pruneVerified = true;
    } else if (value === "--dir") args.dir = String(argv[++index] || "");
    else if (value === "--concurrency") args.concurrency = Number(argv[++index]);
    else {
      console.error(`unknown argument: ${value}`);
      process.exit(2);
    }
  }
  if (args.dir && !BLOB_DIRS.includes(args.dir)) {
    console.error(`--dir must be one of ${BLOB_DIRS.join(", ")}`);
    process.exit(2);
  }
  return args;
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
