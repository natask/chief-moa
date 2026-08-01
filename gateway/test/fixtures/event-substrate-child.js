"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const mode = String(process.env.MOA_EVENT_CHILD_MODE || "append");
const EXACT_INSTANCE_ID = "event-substrate-exact-live-instance";

function injectedError(operation) {
  const error = new Error(`injected ${operation} failure`);
  error.code = "EACCES";
  return error;
}

if (mode === "candidate-unlink-fail-once" || mode === "crash-after-lock") {
  const originalUnlinkSync = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = function patchedUnlinkSync(filePath) {
    const target = String(filePath || "");
    if (!injected && target.includes(".append.lock.candidate-")) {
      injected = true;
      if (mode === "crash-after-lock") process.exit(71);
      throw injectedError("candidate unlink");
    }
    return originalUnlinkSync.apply(this, arguments);
  };
}

if (mode === "release-rename-fail-once"
  || mode === "release-rename-fail-three-then-retry"
  || mode === "crash-before-release") {
  const originalRenameSync = fs.renameSync;
  let injected = 0;
  fs.renameSync = function patchedRenameSync(source, destination) {
    const from = String(source || "");
    const to = String(destination || "");
    const injectionLimit = mode === "release-rename-fail-three-then-retry" ? 3 : 1;
    if (injected < injectionLimit
      && from.endsWith("product-events.jsonl.append.lock")
      && to.includes(".retired-")) {
      injected += 1;
      if (mode === "crash-before-release") process.exit(73);
      throw injectedError("canonical lock rename");
    }
    return originalRenameSync.apply(this, arguments);
  };
}

if (mode === "crash-after-claim") {
  const originalLinkSync = fs.linkSync;
  let injected = false;
  fs.linkSync = function patchedLinkSync(source, destination) {
    const result = originalLinkSync.apply(this, arguments);
    if (!injected && String(destination || "").includes(".append.lock.claim-")) {
      injected = true;
      process.exit(72);
    }
    return result;
  };
}

if (mode === "candidate-disappear-before-link-once") {
  const originalLinkSync = fs.linkSync;
  let injected = false;
  fs.linkSync = function patchedLinkSync(source, destination) {
    if (!injected
      && String(source || "").includes(".append.lock.candidate-")
      && String(destination || "").endsWith("product-events.jsonl.append.lock")) {
      injected = true;
      fs.unlinkSync(source);
    }
    return originalLinkSync.apply(this, arguments);
  };
}

const originalRandomUUID = crypto.randomUUID;
if (mode === "exact-live-instance-lock") {
  let first = true;
  crypto.randomUUID = function patchedRandomUUID() {
    if (first) {
      first = false;
      return EXACT_INSTANCE_ID;
    }
    return originalRandomUUID.apply(this, arguments);
  };
}
const { createEventSubstrateStore } = require("../../lib/event-substrate");
crypto.randomUUID = originalRandomUUID;

async function main() {
  const dataDir = String(process.env.MOA_EVENT_DATA_DIR || "");
  const input = JSON.parse(String(process.env.MOA_EVENT_INPUT || "{}"));
  if (mode === "exact-live-instance-lock") {
    fs.mkdirSync(dataDir, { recursive: true });
    const exactLockPath = path.join(dataDir, "product-events.jsonl.append.lock");
    fs.writeFileSync(exactLockPath, `${JSON.stringify({
      owner_id: "exact-live-instance-owner",
      pid: process.pid,
      host: os.hostname(),
      process_instance_id: EXACT_INSTANCE_ID,
      acquired_at: new Date(0).toISOString(),
    })}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(exactLockPath, old, old);
  }
  const store = createEventSubstrateStore({
    dataDir,
    originId: String(process.env.MOA_EVENT_ORIGIN_ID || "child-process-test"),
    jsonLockTimeoutMs: Number(process.env.MOA_EVENT_LOCK_TIMEOUT_MS || 2_000),
    jsonLockRetryMs: Number(process.env.MOA_EVENT_LOCK_RETRY_MS || 5),
    jsonLockStaleMs: Number(process.env.MOA_EVENT_LOCK_STALE_MS || 100),
  });
  if (mode === "release-rename-fail-three-then-retry") {
    let firstError = null;
    try {
      await store.appendEvent(input);
    } catch (error) {
      firstError = { code: error?.code || "", message: error?.message || String(error) };
    }
    if (!firstError) throw new Error("expected first release attempt to fail");
    const result = await store.appendEvent(input);
    process.stdout.write(JSON.stringify({ ok: true, firstError, result }));
    return;
  }
  const result = await store.appendEvent(input);
  process.stdout.write(JSON.stringify({ ok: true, result }));
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: {
      name: error?.name || "Error",
      code: error?.code || "",
      message: error?.message || String(error),
      expected_stream_version: error?.expected_stream_version,
      actual_stream_version: error?.actual_stream_version,
    },
  }));
  process.exitCode = 2;
});
