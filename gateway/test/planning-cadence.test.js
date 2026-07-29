"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventSubstrateStore } = require("../lib/event-substrate");
const {
  createPlanningCadence, periodKeyFor, parentPeriodKey, ancestry, parentHorizon, childHorizon, HORIZONS,
} = require("../lib/planning-cadence");

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-planning-cadence-"));
  const events = createEventSubstrateStore({ dataDir, originId: "test" });
  let index = 0;
  const now = () => `2026-07-28T00:00:0${index++}.000Z`;
  return { dataDir, events, plane: createPlanningCadence({ events, now, idFactory: (prefix) => `${prefix}_stable` }), now };
}

test("period_key math is deterministic and reversible through the parent chain", () => {
  // 2026-07-28 is a Tuesday in ISO week 31.
  assert.equal(periodKeyFor("day", new Date("2026-07-28T00:00:00Z")), "2026-07-28");
  assert.equal(periodKeyFor("week", new Date("2026-07-28T00:00:00Z")), "2026-W31");
  assert.equal(periodKeyFor("month", new Date("2026-07-28T00:00:00Z")), "2026-07");
  assert.equal(periodKeyFor("quarter", new Date("2026-07-28T00:00:00Z")), "2026-Q3");
  assert.equal(periodKeyFor("year", new Date("2026-07-28T00:00:00Z")), "2026");
  assert.equal(periodKeyFor("five_year", new Date("2026-07-28T00:00:00Z")), "2025-2029");
  assert.equal(periodKeyFor("ten_year", new Date("2026-07-28T00:00:00Z")), "2020-2029");
  assert.equal(periodKeyFor("lifelong", new Date("2026-07-28T00:00:00Z")), "lifelong");

  assert.deepEqual(parentPeriodKey("day", "2026-07-28"), { horizon: "week", period_key: "2026-W31" });
  assert.deepEqual(parentPeriodKey("week", "2026-W31"), { horizon: "month", period_key: "2026-07" });
  assert.deepEqual(parentPeriodKey("month", "2026-07"), { horizon: "quarter", period_key: "2026-Q3" });
  assert.deepEqual(parentPeriodKey("quarter", "2026-Q3"), { horizon: "year", period_key: "2026" });
  assert.deepEqual(parentPeriodKey("year", "2026"), { horizon: "five_year", period_key: "2025-2029" });
  assert.deepEqual(parentPeriodKey("five_year", "2025-2029"), { horizon: "ten_year", period_key: "2020-2029" });
  assert.deepEqual(parentPeriodKey("ten_year", "2020-2029"), { horizon: "lifelong", period_key: "lifelong" });
  assert.equal(parentPeriodKey("lifelong", "lifelong"), null);

  // A week spanning a month boundary still resolves to exactly one month (the
  // one containing its Monday), so week->month linkage is never ambiguous.
  assert.deepEqual(parentPeriodKey("week", "2026-W53"), { horizon: "month", period_key: "2026-12" });

  assert.equal(parentHorizon("day"), "week");
  assert.equal(childHorizon("week"), "day");
  assert.equal(parentHorizon("lifelong"), null);
  assert.equal(childHorizon("day"), null);
  assert.deepEqual(HORIZONS, ["day", "week", "month", "quarter", "year", "five_year", "ten_year", "lifelong"]);
});

test("ancestry walks a single day all the way up to lifelong", () => {
  const chain = ancestry("day", "2026-07-28");
  assert.deepEqual(chain.map((item) => item.horizon), ["day", "week", "month", "quarter", "year", "five_year", "ten_year", "lifelong"]);
  assert.equal(chain[0].period_key, "2026-07-28");
  assert.equal(chain[chain.length - 1].period_key, "lifelong");
});

test("a plan always carries deterministic parent linkage even with no parent plan on record", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  const plan = await f.plane.createPlan({
    horizon: "day", date: "2026-07-28T09:00:00Z",
    intentions: ["20 min exercise", { text: "ship planning cadence", linked_intent_id: "intent_1" }],
    source: { surface: "voice", session_id: "s1" },
    idempotency_key: "day-plan-one",
  });
  assert.equal(plan.period_key, "2026-07-28");
  assert.equal(plan.parent_horizon, "week");
  assert.equal(plan.parent_period_key, "2026-W31");
  assert.deepEqual(plan.intentions[1], { text: "ship planning cadence", linked_intent_id: "intent_1" });

  // No weekly plan was ever created; that must not error or corrupt the day.
  const weekPlan = await f.plane.getPlan("week", "2026-W31");
  assert.equal(weekPlan, null);
});

test("a review auto-links the latest matching plan, and skipping never blocks the parent horizon", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  const plan = await f.plane.createPlan({
    horizon: "day", period_key: "2026-07-28", intentions: ["deep work"], idempotency_key: "plan-for-review",
  });
  const review = await f.plane.createReview({
    review_id: "review_day", horizon: "day", period_key: "2026-07-28", outcome_summary: "Shipped the record shape",
    carry_forward: ["polish handlers"], idempotency_key: "review-one",
  });
  assert.equal(review.plan_id, plan.plan_id);
  assert.equal(review.status, "completed");
  assert.equal(review.parent_horizon, "week");

  const skipped = await f.plane.createReview({
    review_id: "review_week", horizon: "week", period_key: "2026-W31", status: "skipped", skipped_reason: "traveling",
    idempotency_key: "review-week-skip",
  });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.plan_id, ""); // no weekly plan existed; that is fine, not an error.
  assert.equal(skipped.parent_horizon, "month");

  // The month above a skipped week must still resolve cleanly.
  const monthRollup = await f.plane.rollup("month", "2026-07");
  assert.equal(monthRollup.plan, null);
  assert.equal(monthRollup.children.length, 1);
  assert.equal(monthRollup.children[0].period_key, "2026-W31");
  assert.equal(monthRollup.children[0].review.status, "skipped");
});

test("rollup surfaces every distinct child period once, unions plans and skip-only reviews", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  await f.plane.createPlan({ plan_id: "plan_day27", horizon: "day", period_key: "2026-07-27", intentions: ["a"], idempotency_key: "d1" });
  await f.plane.createReview({ review_id: "review_day27", horizon: "day", period_key: "2026-07-27", outcome_summary: "done", idempotency_key: "r1" });
  await f.plane.createReview({ review_id: "review_day28", horizon: "day", period_key: "2026-07-28", status: "skipped", idempotency_key: "r2" });
  await f.plane.createPlan({ plan_id: "plan_week31", horizon: "week", period_key: "2026-W31", intentions: ["ship it"], idempotency_key: "w1" });

  const rollup = await f.plane.rollup("week", "2026-W31");
  assert.equal(rollup.plan.plan_id, "plan_week31");
  const periods = rollup.children.map((item) => item.period_key).sort();
  assert.deepEqual(periods, ["2026-07-27", "2026-07-28"]);
  const day27 = rollup.children.find((item) => item.period_key === "2026-07-27");
  assert.equal(day27.plan.intentions[0].text, "a");
  assert.equal(day27.review.outcome_summary, "done");
  const day28 = rollup.children.find((item) => item.period_key === "2026-07-28");
  assert.equal(day28.plan, null);
  assert.equal(day28.review.status, "skipped");

  // The day horizon has no child horizon; rollup still resolves with an empty list.
  const leaf = await f.plane.rollup("day", "2026-07-27");
  assert.deepEqual(leaf.children, []);
});

test("idempotent replay returns the same record and rejects a foreign key collision", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  const input = { horizon: "day", period_key: "2026-07-28", intentions: ["x"], idempotency_key: "same-key", plan_id: "plan_dup" };
  const first = await f.plane.createPlan(input);
  const replay = await f.plane.createPlan(input);
  assert.deepEqual(replay, first);
  await assert.rejects(() => f.plane.createPlan({ ...input, intentions: ["y"] }), /plan idempotency collision/);

  await assert.rejects(() => f.plane.createReview({ horizon: "decade", period_key: "x" }), /unsupported horizon/);
  await assert.rejects(() => f.plane.createReview({ horizon: "day", period_key: "2026-07-28" }), /outcome_summary is required/);
});

test("restart rehydrates plans, reviews and rollups from the durable event log alone", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  await f.plane.createPlan({ horizon: "day", period_key: "2026-07-28", intentions: ["a"], idempotency_key: "p1" });
  await f.plane.createReview({ horizon: "day", period_key: "2026-07-28", outcome_summary: "done", idempotency_key: "r1" });

  const restarted = createPlanningCadence({ events: f.events, now: f.now });
  const plan = await restarted.getPlan("day", "2026-07-28");
  assert.equal(plan.intentions[0].text, "a");
  const review = await restarted.getReview("day", "2026-07-28");
  assert.equal(review.plan_id, plan.plan_id);
  const listed = await restarted.listPlans({ horizon: "day" });
  assert.equal(listed.total, 1);
});
