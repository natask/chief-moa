"use strict";

// Planning & review cadence: nested-horizon plan/review records over the
// existing product-event substrate (same pattern as lib/intent-plane.js).
//
// Scope is the RECORD SHAPE and its CROSS-HORIZON LINKAGE, not scheduling or
// voice UX. A plan or review at horizon H always carries a deterministic
// parent_horizon/parent_period_key computed from its own period_key, so a
// daily plan always knows which week it belongs to even if that weekly plan
// was never created (or vice versa). Rollups are queried, not required to
// exist: a missing week does not corrupt the month, and a skipped review is
// a first-class outcome, not an error.
//
// This module does not own intentions. `linked_intent_id` fields are opaque
// references into the intent plane (lib/intent-plane.js); they are stored
// and returned, never validated or dereferenced here, so this store never
// takes a hard dependency on intent-plane's shape or availability.

const crypto = require("node:crypto");

const HORIZONS = Object.freeze(["day", "week", "month", "quarter", "year", "five_year", "ten_year", "lifelong"]);
const HORIZON_SET = new Set(HORIZONS);
const EVENT_TYPES = Object.freeze(["planning_cadence.plan.created", "planning_cadence.review.created"]);
const REVIEW_STATUSES = new Set(["completed", "skipped"]);

function parentHorizon(horizon) {
  const index = HORIZONS.indexOf(horizon);
  if (index < 0 || index === HORIZONS.length - 1) return null;
  return HORIZONS[index + 1];
}

function childHorizon(horizon) {
  const index = HORIZONS.indexOf(horizon);
  if (index <= 0) return null;
  return HORIZONS[index - 1];
}

// --- period-key math -------------------------------------------------
// Every horizon has a canonical, sortable period_key string and a matching
// "anchor date" (the first instant inside that period). Parent linkage is
// always derived by taking the anchor date and re-deriving the parent
// horizon's key from it, so the two directions can never drift apart.

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0 .. Sunday = 6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday defines the ISO week/year
  const isoYear = d.getUTCFullYear();
  const week1Monday = mondayOfIsoWeek1(isoYear);
  const weekNum = Math.round((d - week1Monday) / (7 * 86400000)) + 1;
  return `${isoYear}-W${pad2(weekNum)}`;
}

function mondayOfIsoWeek1(isoYear) {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4DayNum);
  return monday;
}

function mondayOfIsoWeekKey(periodKey) {
  const match = String(periodKey || "").match(/^(\d{4})-W(\d{2})$/);
  if (!match) throw new Error(`invalid week period_key: ${periodKey}`);
  const isoYear = Number(match[1]);
  const week = Number(match[2]);
  const monday = mondayOfIsoWeek1(isoYear);
  monday.setUTCDate(monday.getUTCDate() + (week - 1) * 7);
  return monday;
}

function fiveYearBucketStart(year) {
  return Math.floor(year / 5) * 5;
}

function tenYearBucketStart(year) {
  return Math.floor(year / 10) * 10;
}

function periodKeyFor(horizon, date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error("invalid date for period_key");
  const year = d.getUTCFullYear();
  switch (horizon) {
    case "day": return `${year}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    case "week": return isoWeekKey(d);
    case "month": return `${year}-${pad2(d.getUTCMonth() + 1)}`;
    case "quarter": return `${year}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    case "year": return `${year}`;
    case "five_year": { const start = fiveYearBucketStart(year); return `${start}-${start + 4}`; }
    case "ten_year": { const start = tenYearBucketStart(year); return `${start}-${start + 9}`; }
    case "lifelong": return "lifelong";
    default: throw new Error(`unsupported horizon: ${horizon}`);
  }
}

function anchorDateOf(horizon, periodKey) {
  const key = String(periodKey || "");
  switch (horizon) {
    case "day": return new Date(`${key}T00:00:00.000Z`);
    case "week": return mondayOfIsoWeekKey(key);
    case "month": { const m = key.match(/^(\d{4})-(\d{2})$/); if (!m) throw new Error(`invalid month period_key: ${key}`); return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)); }
    case "quarter": { const m = key.match(/^(\d{4})-Q([1-4])$/); if (!m) throw new Error(`invalid quarter period_key: ${key}`); return new Date(Date.UTC(Number(m[1]), (Number(m[2]) - 1) * 3, 1)); }
    case "year": { const m = key.match(/^(\d{4})$/); if (!m) throw new Error(`invalid year period_key: ${key}`); return new Date(Date.UTC(Number(m[1]), 0, 1)); }
    case "five_year": case "ten_year": { const m = key.match(/^(\d{4})-(\d{4})$/); if (!m) throw new Error(`invalid ${horizon} period_key: ${key}`); return new Date(Date.UTC(Number(m[1]), 0, 1)); }
    case "lifelong": return null;
    default: throw new Error(`unsupported horizon: ${horizon}`);
  }
}

// Deterministic parent link: null only for the top of the chain (lifelong).
function parentPeriodKey(horizon, periodKey) {
  const parent = parentHorizon(horizon);
  if (!parent) return null;
  const anchor = anchorDateOf(horizon, periodKey);
  return { horizon: parent, period_key: periodKeyFor(parent, anchor) };
}

// Full ancestor chain from `horizon` up to and including lifelong. Pure and
// synchronous: no event lookups, so a ritual can compute "which plans do I
// need to read before this conversation" without touching storage first.
function ancestry(horizon, periodKey) {
  const chain = [{ horizon, period_key: periodKey }];
  let current = { horizon, period_key: periodKey };
  for (;;) {
    const parent = parentPeriodKey(current.horizon, current.period_key);
    if (!parent) return chain;
    chain.push(parent);
    current = parent;
  }
}

// --- shared value helpers (mirrors lib/intent-plane.js) ---------------

function clean(value, max = 2_000) {
  const result = String(value || "").trim();
  if (result.length > max) throw new Error(`value exceeds ${max} characters`);
  return result;
}

function required(value, label, max = 2_000) {
  const result = clean(value, max);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeMetadata(value, label) {
  const object = plainObject(value);
  const serialized = JSON.stringify(object);
  if (serialized.length > 4_000) throw new Error(`${label} exceeds 4000 characters`);
  const forbidden = /password|passwd|secret|token|credential|cookie|authorization|api[_-]?key/i;
  const visit = (item) => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.test(key)) throw new Error(`${label} must not contain credentials`);
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(object);
  return JSON.parse(serialized);
}

// Normalizes a list of plain strings or { text, linked_intent_id } objects.
// linked_intent_id is opaque here: an intent-plane id the caller vouches for.
function normalizeItems(value, maxItems = 40) {
  const list = Array.isArray(value) ? value : [];
  return list.slice(0, maxItems).map((item) => {
    if (typeof item === "string") return { text: clean(item, 400), linked_intent_id: "" };
    const object = plainObject(item);
    return { text: clean(object.text, 400), linked_intent_id: clean(object.linked_intent_id, 160) };
  }).filter((item) => item.text);
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function streamId(kind, id) {
  return `planning-cadence:${kind}:${id}`;
}

function idempotencyKey(kind, id, operation, raw) {
  const digest = crypto.createHash("sha256").update(required(raw, "idempotency_key", 240)).digest("hex").slice(0, 32);
  return `planning-cadence:${kind}:${id}:${operation}:${digest}`;
}

function assertExactReplay(current, payload, label) {
  for (const key of Object.keys(payload)) {
    if (JSON.stringify(current?.[key]) !== JSON.stringify(payload[key])) {
      throw new Error(`${label} idempotency collision`);
    }
  }
}

function assertHorizon(horizon) {
  const value = clean(horizon, 40);
  if (!HORIZON_SET.has(value)) throw new Error(`unsupported horizon: ${horizon}`);
  return value;
}

function resolvePeriodKey(horizon, input) {
  const explicit = clean(input.period_key, 40);
  if (explicit) return explicit;
  const date = clean(input.date, 40);
  return periodKeyFor(horizon, date ? new Date(date) : new Date());
}

function reduce(events) {
  const plans = new Map();
  const reviews = new Map();
  for (const event of events) {
    const payload = plainObject(event.payload);
    if (event.event_type === "planning_cadence.plan.created") {
      plans.set(payload.plan_id, { ...payload, version: event.stream_version, created_at: event.occurred_at });
    } else if (event.event_type === "planning_cadence.review.created") {
      reviews.set(payload.review_id, { ...payload, version: event.stream_version, created_at: event.occurred_at });
    }
  }
  return { plans, reviews };
}

function latestFor(records, horizon, periodKey) {
  const matches = records.filter((item) => item.horizon === horizon && item.period_key === periodKey);
  if (!matches.length) return null;
  return matches.slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).slice(-1)[0];
}

function createPlanningCadence({ events, now = () => new Date().toISOString(), idFactory = makeId } = {}) {
  if (!events?.appendEvent || !events?.listEvents) throw new Error("planning cadence requires the event substrate");

  async function allEvents() {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const page = await events.listEvents({ event_type_prefix: "planning_cadence.", order: "asc", limit: 500, offset });
      rows.push(...page.filter((event) => EVENT_TYPES.includes(event.event_type)));
      if (page.length < 500) return rows;
    }
  }

  async function state() {
    return reduce(await allEvents());
  }

  async function firstPayload(kind, id) {
    const rows = await events.listEvents({ stream_id: streamId(kind, id), order: "asc", limit: 1 });
    return plainObject(rows[0]?.payload);
  }

  async function append(kind, id, operation, type, payload, rawKey) {
    const expectedStream = streamId(kind, id);
    const expectedKey = idempotencyKey(kind, id, operation, rawKey);
    const event = await events.appendEvent({
      stream_id: expectedStream,
      event_type: type,
      occurred_at: now(),
      actor: { kind: "gateway", id: "planning-cadence" },
      authority: { boundary: "planning-cadence", execution: "none" },
      correlation_id: payload.plan_id || payload.review_id || id,
      idempotency_key: expectedKey,
      expected_stream_version: 0,
      payload,
    });
    if (event?.stream_id !== expectedStream || event?.event_type !== type
      || event?.idempotency_key !== expectedKey
      || JSON.stringify(event?.payload) !== JSON.stringify(payload)) {
      throw new Error(`idempotency collision for ${expectedKey}`);
    }
    return event;
  }

  // Creates (or, on retry with the same idempotency key, returns) a plan
  // record. Parent linkage is always computed, never supplied by the caller,
  // so the tree cannot be pointed somewhere inconsistent with its own period.
  async function createPlan(input = {}) {
    const horizon = assertHorizon(input.horizon);
    const periodKey = resolvePeriodKey(horizon, input);
    const parent = parentPeriodKey(horizon, periodKey);
    const planId = clean(input.plan_id, 160) || idFactory("plan");
    const payload = {
      plan_id: planId,
      horizon,
      period_key: periodKey,
      parent_horizon: parent ? parent.horizon : "",
      parent_period_key: parent ? parent.period_key : "",
      intentions: normalizeItems(input.intentions),
      note: clean(input.note, 4_000),
      source: safeMetadata(input.source, "source"),
      status: clean(input.status, 40) || "active",
      carried_from_review_id: clean(input.carried_from_review_id, 160),
    };
    const current = await state();
    if (current.plans.has(planId)) {
      assertExactReplay(await firstPayload("plan", planId), payload, "plan");
      return current.plans.get(planId);
    }
    await append("plan", planId, "create", EVENT_TYPES[0], payload, input.idempotency_key || planId);
    return (await state()).plans.get(planId);
  }

  // Creates a review for a period. `plan_id` auto-resolves to the latest plan
  // at the same horizon+period when not supplied; a review with no matching
  // plan (planning was skipped, or never got that granular) is valid.
  async function createReview(input = {}) {
    const horizon = assertHorizon(input.horizon);
    const periodKey = resolvePeriodKey(horizon, input);
    const parent = parentPeriodKey(horizon, periodKey);
    const status = clean(input.status, 40) || "completed";
    if (!REVIEW_STATUSES.has(status)) throw new Error("unsupported review status");
    if (status === "completed") required(input.outcome_summary, "outcome_summary");
    const currentState = await state();
    const linkedPlan = clean(input.plan_id, 160) || latestFor([...currentState.plans.values()], horizon, periodKey)?.plan_id || "";
    const reviewId = clean(input.review_id, 160) || idFactory("review");
    const payload = {
      review_id: reviewId,
      horizon,
      period_key: periodKey,
      parent_horizon: parent ? parent.horizon : "",
      parent_period_key: parent ? parent.period_key : "",
      plan_id: linkedPlan,
      status,
      outcome_summary: clean(input.outcome_summary, 4_000),
      carry_forward: normalizeItems(input.carry_forward),
      skipped_reason: status === "skipped" ? clean(input.skipped_reason, 800) : "",
      source: safeMetadata(input.source, "source"),
    };
    if (currentState.reviews.has(reviewId)) {
      assertExactReplay(await firstPayload("review", reviewId), payload, "review");
      return currentState.reviews.get(reviewId);
    }
    await append("review", reviewId, "create", EVENT_TYPES[1], payload, input.idempotency_key || reviewId);
    return (await state()).reviews.get(reviewId);
  }

  async function getPlan(horizon, periodKey) {
    const current = await state();
    return latestFor([...current.plans.values()], assertHorizon(horizon), clean(periodKey, 40));
  }

  async function getReview(horizon, periodKey) {
    const current = await state();
    return latestFor([...current.reviews.values()], assertHorizon(horizon), clean(periodKey, 40));
  }

  async function listPlans(filters = {}) {
    const current = await state();
    return paginate([...current.plans.values()], filters);
  }

  async function listReviews(filters = {}) {
    const current = await state();
    return paginate([...current.reviews.values()], filters);
  }

  function paginate(all, filters) {
    const filtered = all.filter((item) => !filters.horizon || item.horizon === filters.horizon);
    const limit = Math.max(1, Math.min(Number(filters.limit) || 100, 500));
    const offset = Math.max(0, Math.min(Number(filters.offset) || 0, 10_000_000));
    const sorted = filtered.slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    return { total: sorted.length, offset, limit, items: sorted.slice(offset, offset + limit) };
  }

  // One level of rollup: this period's own plan/review plus, for each
  // distinct child-horizon period that points up at it, that child's plan
  // and review. Missing children are simply absent from the list -- a
  // skipped or never-run child period never blocks this from resolving.
  async function rollup(horizon, periodKey) {
    const h = assertHorizon(horizon);
    const key = clean(periodKey, 40);
    const current = await state();
    const own = { horizon: h, period_key: key, plan: latestFor([...current.plans.values()], h, key), review: latestFor([...current.reviews.values()], h, key) };
    const child = childHorizon(h);
    if (!child) return { ...own, children: [] };
    const childPeriods = new Set();
    for (const item of [...current.plans.values(), ...current.reviews.values()]) {
      if (item.horizon === child && item.parent_horizon === h && item.parent_period_key === key) childPeriods.add(item.period_key);
    }
    const children = [...childPeriods].sort().map((childKey) => ({
      horizon: child,
      period_key: childKey,
      plan: latestFor([...current.plans.values()], child, childKey),
      review: latestFor([...current.reviews.values()], child, childKey),
    }));
    return { ...own, children };
  }

  return {
    createPlan, createReview, getPlan, getReview, listPlans, listReviews, rollup,
  };
}

module.exports = {
  createPlanningCadence,
  planningCadenceEventTypes: EVENT_TYPES,
  HORIZONS,
  parentHorizon,
  childHorizon,
  periodKeyFor,
  parentPeriodKey,
  ancestry,
};
