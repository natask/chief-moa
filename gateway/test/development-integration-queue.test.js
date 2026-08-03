"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createDevelopmentIntegrationQueue } = require("../lib/development-integration-queue");

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "development-integration-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let time = Date.parse("2026-08-02T00:00:00Z");
  const events = createEventSubstrateStore({ dataDir, originId: "test" });
  const queue = createDevelopmentIntegrationQueue({ events, now: () => new Date(time), leaseMs: 60_000 });
  return { dataDir, queue, advance: (ms) => { time += ms; }, now: () => time };
}

test("one restart-safe lease serializes integration across intents", async (t) => {
  const { dataDir, queue } = setup(t);
  await queue.enqueue("intent_a", "integrate");
  await queue.enqueue("intent_b", "integrate");
  const first = await queue.claim("intent_a", "integrate");
  assert.equal(first.acquired, true);
  await queue.bindRun("intent_a", "integrate", "run_a");
  assert.equal((await queue.claim("intent_b", "integrate")).acquired, false);

  const restarted = createDevelopmentIntegrationQueue({
    events: createEventSubstrateStore({ dataDir, originId: "test" }),
    now: () => new Date("2026-08-02T00:00:30Z"),
    leaseMs: 60_000,
  });
  assert.equal((await restarted.read()).active.run_id, "run_a");
  await restarted.release("intent_a", "integrate", "completed");
  assert.equal((await restarted.claim("intent_b", "integrate")).acquired, true);
});

test("expired and failed dispatch leases become runnable again", async (t) => {
  const { queue, advance } = setup(t);
  await queue.enqueue("intent_a", "integrate");
  await queue.claim("intent_a", "integrate");
  advance(60_001);
  assert.equal((await queue.claim("intent_a", "integrate")).acquired, true);
  await queue.release("intent_a", "integrate", "dispatch-failed");
  assert.equal((await queue.claim("intent_a", "integrate")).acquired, true);
});
