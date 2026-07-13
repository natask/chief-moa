"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createEventSubstrateStore } = require("../lib/event-substrate");

const CHILD_PATH = path.join(__dirname, "fixtures", "event-substrate-child.js");
const EVENTS_FILENAME = "product-events.jsonl";

function input(idempotencyKey, expectedVersion) {
  const event = {
    event_type: "intent.enriched",
    stream_id: "intent:child-process-cas",
    idempotency_key: idempotencyKey,
    payload: { intent_id: "child-process-cas", key: idempotencyKey },
  };
  if (expectedVersion !== undefined) event.expected_stream_version = expectedVersion;
  return event;
}

function runChild(dataDir, event, mode = "append", options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD_PATH], {
      env: {
        ...process.env,
        MOA_EVENT_CHILD_MODE: mode,
        MOA_EVENT_DATA_DIR: dataDir,
        MOA_EVENT_INPUT: JSON.stringify(event),
        MOA_EVENT_LOCK_TIMEOUT_MS: String(options.timeoutMs || 2_000),
        MOA_EVENT_LOCK_RETRY_MS: String(options.retryMs || 5),
        MOA_EVENT_LOCK_STALE_MS: String(options.staleMs || 100),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`event substrate child timed out: ${mode}`));
    }, 8_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      let json = null;
      if (stdout.trim()) {
        try { json = JSON.parse(stdout); } catch {}
      }
      resolve({ code, signal, stdout, stderr, json });
    });
  });
}

function lockPath(dataDir) {
  return path.join(dataDir, `${EVENTS_FILENAME}.append.lock`);
}

function lockArtifacts(dataDir) {
  return fs.readdirSync(dataDir).filter((name) => name.startsWith(`${EVENTS_FILENAME}.append.lock`));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("real child processes serialize compare-and-append and preserve exact retry", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-child-cas-"));
  try {
    const store = createEventSubstrateStore({ dataDir, originId: "child-process-test" });
    const seeded = await store.appendEvent(input("seed", 0));
    assert.equal(seeded.stream_version, 1);

    const commands = [input("child-race-one", 1), input("child-race-two", 1)];
    const results = await Promise.all(commands.map((event) => runChild(dataDir, event)));
    assert.deepEqual(results.map((result) => result.code).sort(), [0, 2]);
    const winnerIndex = results.findIndex((result) => result.code === 0);
    const loser = results.find((result) => result.code === 2);
    assert.equal(loser.json?.error?.code, "EVENT_STREAM_VERSION_CONFLICT");

    const retry = await runChild(dataDir, commands[winnerIndex]);
    assert.equal(retry.code, 0, retry.stderr || retry.stdout);
    assert.deepEqual(retry.json.result, results[winnerIndex].json.result);

    const stream = await store.listEvents({ stream_id: "intent:child-process-cas", order: "asc", limit: 10 });
    assert.deepEqual(stream.map((event) => event.stream_version), [1, 2]);
    assert.deepEqual(lockArtifacts(dataDir), []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("candidate cleanup and post-fsync rename faults do not strand the canonical lock", async () => {
  const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-candidate-fault-"));
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-release-fault-"));
  const liveRetryDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-live-release-retry-"));
  try {
    const first = await runChild(candidateDir, input("candidate-first", 0), "candidate-unlink-fail-once");
    assert.equal(first.code, 0, first.stderr || first.stdout);
    const compatible = await runChild(candidateDir, {
      ...input("candidate-compatible"),
      stream_version: 99,
    });
    assert.equal(compatible.code, 0, compatible.stderr || compatible.stdout);
    assert.equal(compatible.json.result.stream_version, 2);
    assert.deepEqual(lockArtifacts(candidateDir), []);

    const durable = await runChild(releaseDir, input("release-durable", 0), "release-rename-fail-once");
    assert.equal(durable.code, 0, durable.stderr || durable.stdout);
    const retried = await runChild(releaseDir, input("release-durable", 0));
    assert.equal(retried.code, 0, retried.stderr || retried.stdout);
    assert.deepEqual(retried.json.result, durable.json.result);
    assert.deepEqual(lockArtifacts(releaseDir), []);

    const liveRetry = await runChild(
      liveRetryDir,
      input("live-release-retry", 0),
      "release-rename-fail-three-then-retry",
    );
    assert.equal(liveRetry.code, 0, liveRetry.stderr || liveRetry.stdout);
    assert.equal(liveRetry.json.firstError.code, "EACCES");
    assert.equal(liveRetry.json.result.stream_version, 1);
    assert.deepEqual(lockArtifacts(liveRetryDir), []);
  } finally {
    fs.rmSync(candidateDir, { recursive: true, force: true });
    fs.rmSync(releaseDir, { recursive: true, force: true });
    fs.rmSync(liveRetryDir, { recursive: true, force: true });
  }
});

test("owner crashes before append and after fsync recover without losing idempotency", async () => {
  const beforeDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-owner-crash-"));
  const afterDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-release-crash-"));
  try {
    const before = await runChild(beforeDir, input("owner-crash", 0), "crash-after-lock");
    assert.equal(before.code, 71);
    assert.equal(fs.existsSync(lockPath(beforeDir)), true);
    await sleep(150);
    const recovered = await runChild(beforeDir, input("owner-recovered", 0));
    assert.equal(recovered.code, 0, recovered.stderr || recovered.stdout);
    assert.equal(recovered.json.result.stream_version, 1);
    assert.deepEqual(lockArtifacts(beforeDir), []);

    const after = await runChild(afterDir, input("post-fsync-crash", 0), "crash-before-release");
    assert.equal(after.code, 73);
    const store = createEventSubstrateStore({ dataDir: afterDir, originId: "child-process-test" });
    const durable = await store.listEvents({ stream_id: "intent:child-process-cas", order: "asc", limit: 10 });
    assert.equal(durable.length, 1);
    await sleep(150);
    const exactRetry = await runChild(afterDir, input("post-fsync-crash", 0));
    assert.equal(exactRetry.code, 0, exactRetry.stderr || exactRetry.stdout);
    assert.deepEqual(exactRetry.json.result, durable[0]);
    assert.deepEqual(lockArtifacts(afterDir), []);
  } finally {
    fs.rmSync(beforeDir, { recursive: true, force: true });
    fs.rmSync(afterDir, { recursive: true, force: true });
  }
});

test("claim crash is adopted by exact stale inode and never strands a successor", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-claim-crash-"));
  try {
    const owner = await runChild(dataDir, input("claim-owner", 0), "crash-after-lock");
    assert.equal(owner.code, 71);
    await sleep(150);
    const reaper = await runChild(dataDir, input("claim-reaper", 0), "crash-after-claim");
    assert.equal(reaper.code, 72);
    assert.equal(lockArtifacts(dataDir).some((name) => name.includes(".claim-")), true);

    const recovered = await runChild(dataDir, input("claim-recovered", 0));
    assert.equal(recovered.code, 0, recovered.stderr || recovered.stdout);
    assert.equal(recovered.json.result.stream_version, 1);
    const successor = await runChild(dataDir, input("claim-successor", 1));
    assert.equal(successor.code, 0, successor.stderr || successor.stdout);
    assert.equal(successor.json.result.stream_version, 2);
    assert.deepEqual(lockArtifacts(dataDir), []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("concurrent stale reapers cannot retire the successor owner's lock", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-reaper-race-"));
  try {
    const owner = await runChild(dataDir, input("reaper-race-owner", 0), "crash-after-lock");
    assert.equal(owner.code, 71);
    await sleep(150);

    const commands = [input("reaper-race-one", 0), input("reaper-race-two", 0)];
    const results = await Promise.all(commands.map((event) => runChild(dataDir, event)));
    assert.deepEqual(results.map((result) => result.code).sort(), [0, 2]);
    assert.equal(results.find((result) => result.code === 2).json?.error?.code, "EVENT_STREAM_VERSION_CONFLICT");

    const successor = await runChild(dataDir, input("reaper-race-successor", 1));
    assert.equal(successor.code, 0, successor.stderr || successor.stdout);
    assert.equal(successor.json.result.stream_version, 2);
    assert.deepEqual(lockArtifacts(dataDir), []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("stale malformed locks recover but symlink and nonregular boundaries fail closed", async () => {
  const partialDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-partial-lock-"));
  const symlinkEventDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-symlink-file-"));
  const symlinkLockDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-symlink-lock-"));
  const nonregularDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-nonregular-"));
  const nonregularLockDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-lock-nonregular-"));
  try {
    fs.writeFileSync(lockPath(partialDir), "{partial", { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath(partialDir), old, old);
    const partialStore = createEventSubstrateStore({
      dataDir: partialDir,
      originId: "child-process-test",
      jsonLockTimeoutMs: 1_000,
      jsonLockStaleMs: 100,
    });
    assert.equal((await partialStore.appendEvent(input("partial-recovered", 0))).stream_version, 1);

    const eventTarget = path.join(symlinkEventDir, "target.jsonl");
    fs.writeFileSync(eventTarget, "", { mode: 0o600 });
    fs.symlinkSync(eventTarget, path.join(symlinkEventDir, EVENTS_FILENAME));
    const symlinkEventStore = createEventSubstrateStore({ dataDir: symlinkEventDir });
    await assert.rejects(symlinkEventStore.appendEvent(input("unsafe-event", 0)), { code: "EVENT_SUBSTRATE_UNSAFE_PATH" });
    await assert.rejects(symlinkEventStore.listEvents({}), { code: "EVENT_SUBSTRATE_UNSAFE_PATH" });

    const lockTarget = path.join(symlinkLockDir, "target.lock");
    fs.writeFileSync(lockTarget, "{}", { mode: 0o600 });
    fs.symlinkSync(lockTarget, lockPath(symlinkLockDir));
    const symlinkLockStore = createEventSubstrateStore({ dataDir: symlinkLockDir, jsonLockTimeoutMs: 200 });
    await assert.rejects(symlinkLockStore.appendEvent(input("unsafe-lock", 0)), { code: "EVENT_SUBSTRATE_UNSAFE_PATH" });

    fs.mkdirSync(path.join(nonregularDir, EVENTS_FILENAME));
    const nonregularStore = createEventSubstrateStore({ dataDir: nonregularDir });
    await assert.rejects(nonregularStore.appendEvent(input("unsafe-directory", 0)), { code: "EVENT_SUBSTRATE_UNSAFE_PATH" });
    await assert.rejects(nonregularStore.listEvents({}), { code: "EVENT_SUBSTRATE_UNSAFE_PATH" });

    fs.mkdirSync(lockPath(nonregularLockDir));
    const nonregularLockStore = createEventSubstrateStore({ dataDir: nonregularLockDir, jsonLockTimeoutMs: 200 });
    await assert.rejects(nonregularLockStore.appendEvent(input("unsafe-lock-directory", 0)), { code: "EVENT_SUBSTRATE_UNSAFE_PATH" });
  } finally {
    for (const directory of [partialDir, symlinkEventDir, symlinkLockDir, nonregularDir, nonregularLockDir]) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("process-instance recovery honors configured age and never reaps the exact live instance", async () => {
  const priorInstanceDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-prior-instance-"));
  const exactInstanceDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-exact-instance-"));
  try {
    const priorLock = lockPath(priorInstanceDir);
    fs.writeFileSync(priorLock, `${JSON.stringify({
      owner_id: "prior-instance-owner",
      pid: process.pid,
      host: os.hostname(),
      process_instance_id: "definitely-not-this-runtime",
      acquired_at: new Date(0).toISOString(),
    })}\n`, { mode: 0o600 });
    const belowThreshold = new Date(Date.now() - 1_500);
    fs.utimesSync(priorLock, belowThreshold, belowThreshold);
    const priorStore = createEventSubstrateStore({
      dataDir: priorInstanceDir,
      originId: "child-process-test",
      jsonLockTimeoutMs: 150,
      jsonLockRetryMs: 5,
      jsonLockStaleMs: 30_000,
    });
    await assert.rejects(
      priorStore.appendEvent(input("prior-instance-too-young", 0)),
      { code: "EVENT_SUBSTRATE_LOCK_TIMEOUT" },
    );
    assert.equal(fs.existsSync(priorLock), true);

    const beyondThreshold = new Date(Date.now() - 31_000);
    fs.utimesSync(priorLock, beyondThreshold, beyondThreshold);
    const recovered = await priorStore.appendEvent(input("prior-instance-recovered", 0));
    assert.equal(recovered.stream_version, 1);
    assert.deepEqual(lockArtifacts(priorInstanceDir), []);

    const exactLive = await runChild(
      exactInstanceDir,
      input("exact-live-instance-must-not-reap", 0),
      "exact-live-instance-lock",
      { timeoutMs: 150, retryMs: 5, staleMs: 100 },
    );
    assert.equal(exactLive.code, 2, exactLive.stderr || exactLive.stdout);
    assert.equal(exactLive.json?.error?.code, "EVENT_SUBSTRATE_LOCK_TIMEOUT");
    assert.equal(fs.existsSync(lockPath(exactInstanceDir)), true);
  } finally {
    fs.rmSync(priorInstanceDir, { recursive: true, force: true });
    fs.rmSync(exactInstanceDir, { recursive: true, force: true });
  }
});
