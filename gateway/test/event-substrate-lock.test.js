"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  acquireJsonStreamDirLock,
  createEventSubstrateStore,
  releaseJsonStreamDirLock,
} = require("../lib/event-substrate");

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
    // This case verifies compare-and-append serialization, not stale-owner
    // recovery. Keep the stale threshold above a loaded CI scheduler pause so
    // a healthy child is never mistaken for an abandoned lock owner.
    const childOptions = { staleMs: 2_000, timeoutMs: 5_000 };
    const results = await Promise.all(commands.map((event) => runChild(dataDir, event, "append", childOptions)));
    assert.deepEqual(results.map((result) => result.code).sort(), [0, 2]);
    const winnerIndex = results.findIndex((result) => result.code === 0);
    const loser = results.find((result) => result.code === 2);
    assert.equal(loser.json?.error?.code, "EVENT_STREAM_VERSION_CONFLICT");

    const retry = await runChild(dataDir, commands[winnerIndex], "append", childOptions);
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

// withStreamLock: serialized per-stream critical section used by the deployment
// control plane so a read-modify-append transition runs without interleaving.

function makeStore(prefix) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `moa-stream-lock-${prefix}-`));
  return { dataDir, store: createEventSubstrateStore({ dataDir }) };
}

test("withStreamLock serializes concurrent critical sections on the same stream", async () => {
  const { dataDir, store } = makeStore("serialize");
  try {
    const observed = [];
    let active = 0;
    let maxActive = 0;
    const critical = async (tag) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      observed.push(`enter:${tag}`);
      await sleep(25);
      observed.push(`exit:${tag}`);
      active -= 1;
    };
    await Promise.all([
      store.withStreamLock("deployment:same", () => critical("a")),
      store.withStreamLock("deployment:same", () => critical("b")),
      store.withStreamLock("deployment:same", () => critical("c")),
    ]);
    assert.equal(maxActive, 1, "no two critical sections may overlap for one stream");
    // Each enter must be immediately followed by its own exit (no interleave).
    for (let i = 0; i < observed.length; i += 2) {
      assert.equal(observed[i].split(":")[0], "enter");
      assert.equal(observed[i + 1].split(":")[0], "exit");
      assert.equal(observed[i].split(":")[1], observed[i + 1].split(":")[1]);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("withStreamLock makes read-modify-append atomic under contention", async () => {
  const { dataDir, store } = makeStore("atomic");
  try {
    // Ten concurrent transitions each read the current count and append the
    // next one. Without serialization they would collide on stream_version.
    const runs = Array.from({ length: 10 }, (_unused, index) =>
      store.withStreamLock("counter:one", async () => {
        const events = await store.listEvents({ stream_id: "counter:one", order: "asc", limit: 500 });
        const next = events.length + 1;
        return store.appendEvent({
          event_type: "counter.ticked",
          stream_id: "counter:one",
          idempotency_key: `tick-${index}`,
          payload: { next },
        });
      }),
    );
    await Promise.all(runs);
    const finalEvents = await store.listEvents({ stream_id: "counter:one", order: "asc", limit: 500 });
    assert.equal(finalEvents.length, 10);
    const versions = finalEvents.map((event) => event.stream_version).sort((a, b) => a - b);
    assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "no lost update or duplicated version");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("withStreamLock allows distinct streams to proceed independently", async () => {
  const { dataDir, store } = makeStore("distinct");
  try {
    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    let markEntered;
    const firstEntered = new Promise((resolve) => { markEntered = resolve; });
    const firstDone = store.withStreamLock("stream:one", async () => {
      markEntered();
      await firstHeld;
    });
    await firstEntered;
    // A different stream must not be blocked by the still-held first lock.
    const secondRan = await store.withStreamLock("stream:two", async () => "ran");
    assert.equal(secondRan, "ran");
    releaseFirst();
    await firstDone;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("withStreamLock releases the stream after a failed transition", async () => {
  const { dataDir, store } = makeStore("release-on-error");
  try {
    await assert.rejects(
      store.withStreamLock("stream:err", async () => { throw new Error("transition failed"); }),
      /transition failed/,
    );
    // The next caller must acquire immediately rather than time out on a wedged lock.
    const recovered = await store.withStreamLock("stream:err", async () => "recovered");
    assert.equal(recovered, "recovered");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("two stale reapers cannot quarantine the new live winner", async () => {
  // Direct reclaim race on the stream dir lock: a crashed holder left a stale
  // directory with a corrupt owner record, and two contenders judge it stale
  // simultaneously. The reaper mutex plus nonce/inode-bound quarantine must let
  // exactly one contender win, and the loser's reclaim pass must be a no-op
  // against the winner's fresh lock instead of deleting it.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-stream-lock-two-reapers-"));
  const lockDir = path.join(dataDir, "stream.lock");
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "owner.json"), "corrupt-stale-owner");
    const aged = new Date(Date.now() - 2000);
    fs.utimesSync(lockDir, aged, aged);

    const options = { timeoutMs: 150, retryMs: 5, staleMs: 10 };
    const settled = await Promise.allSettled([
      acquireJsonStreamDirLock(lockDir, options),
      acquireJsonStreamDirLock(lockDir, options),
    ]);
    const winners = settled.filter((item) => item.status === "fulfilled");
    assert.equal(winners.length, 1, "exactly one contender owns the replacement lock");
    assert.equal(settled.filter((item) => item.status === "rejected").length, 1);
    const winner = winners[0].value;
    const stored = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    assert.equal(stored.nonce, winner.nonce, "the losing stale reaper must preserve the fresh owner");
    assert.equal(await releaseJsonStreamDirLock(lockDir, winner, options), true);
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
