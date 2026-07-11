"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  appendEventOnClient,
  createEventSubstrateStore,
  EventStreamVersionConflictError,
} = require("../lib/event-substrate");
const { createIntentRuntime } = require("../lib/intent-runtime");

function makeRuntime(tempDir, nowValues = ["2026-07-11T01:00:00.000Z"], eventsOverride) {
  let nowIndex = 0;
  let idIndex = 0;
  return createIntentRuntime({
    events: eventsOverride || createEventSubstrateStore({ dataDir: tempDir, originId: "intent-runtime-test" }),
    idFactory(prefix) {
      idIndex += 1;
      return `${prefix}_${String(idIndex).padStart(4, "0")}`;
    },
    now() {
      const value = nowValues[Math.min(nowIndex, nowValues.length - 1)];
      nowIndex += 1;
      return value;
    },
  });
}

function makeGlobalIdempotencyFakeSubstrate() {
  const events = [];
  let appendFailure = null;
  const substrate = {
    events,
    setAppendFailure(predicate) {
      appendFailure = typeof predicate === "function" ? predicate : null;
    },
    async appendEvent(input = {}) {
      if (appendFailure && appendFailure(input)) throw new Error("injected append failure");
      const existing = events.find((event) => event.idempotency_key === input.idempotency_key || event.event_id === input.event_id);
      if (existing) return structuredClone(existing);
      const streamVersion = events.filter((event) => event.stream_id === input.stream_id).length + 1;
      const expectedVersion = input.expected_stream_version ?? input.expectedStreamVersion;
      if (expectedVersion !== undefined && Number(expectedVersion) !== streamVersion - 1) {
        throw new EventStreamVersionConflictError({
          originId: "fake",
          streamId: input.stream_id,
          expectedVersion: Number(expectedVersion),
          actualVersion: streamVersion - 1,
        });
      }
      const storedInput = structuredClone(input);
      delete storedInput.expected_stream_version;
      delete storedInput.expectedStreamVersion;
      delete storedInput.stream_version;
      delete storedInput.streamVersion;
      const event = {
        ...storedInput,
        event_id: input.event_id || `evt_${events.length + 1}`,
        origin_id: "fake",
        stream_version: streamVersion,
        event_schema_version: 1,
        recorded_at: input.occurred_at,
        actor: input.actor || { kind: "gateway", id: "fake" },
        authority: input.authority || {},
        causation_id: input.causation_id || "",
        correlation_id: input.correlation_id || "",
        blob_refs: [],
        crdt_refs: [],
        signature: "",
      };
      events.push(event);
      return structuredClone(event);
    },
    async listEvents(filter = {}) {
      let rows = [...events];
      if (filter.stream_id) rows = rows.filter((event) => event.stream_id === filter.stream_id);
      if (filter.idempotency_key) rows = rows.filter((event) => event.idempotency_key === filter.idempotency_key);
      if (filter.event_type_prefix) rows = rows.filter((event) => String(event.event_type || "").startsWith(filter.event_type_prefix));
      rows.sort((a, b) => Number(a.stream_version || 0) - Number(b.stream_version || 0));
      const offset = Number(filter.offset || 0);
      const limit = Math.max(1, Math.min(Number(filter.limit || 100), 500));
      return rows.slice(offset, offset + limit).map((row) => structuredClone(row));
    },
  };
  return substrate;
}

function makePostgresCompatibleClient() {
  const rows = [];
  const queryKinds = [];
  return {
    rows,
    queryKinds,
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.startsWith("select pg_advisory_xact_lock")) {
        queryKinds.push("advisory-lock");
        return { rows: [] };
      }
      if (normalized.startsWith("select * from product_events where")) {
        queryKinds.push("idempotency-read");
        const existing = rows.find((row) => params.includes(row.event_id)
          || (row.idempotency_key && params.includes(row.idempotency_key)));
        return { rows: existing ? [structuredClone(existing)] : [] };
      }
      if (normalized.startsWith("select coalesce(max(stream_version), 0) as current_version")) {
        queryKinds.push("version-read");
        const currentVersion = rows
          .filter((row) => row.origin_id === params[0] && row.stream_id === params[1])
          .reduce((maximum, row) => Math.max(maximum, Number(row.stream_version || 0)), 0);
        return { rows: [{ current_version: currentVersion }] };
      }
      if (normalized.startsWith("insert into product_events")) {
        queryKinds.push("insert");
        const row = {
          event_id: params[0],
          origin_id: params[1],
          stream_id: params[2],
          stream_version: params[3],
          event_type: params[4],
          event_schema_version: params[5],
          occurred_at: params[6],
          recorded_at: params[7],
          actor: JSON.parse(params[8]),
          authority: JSON.parse(params[9]),
          causation_id: params[10],
          correlation_id: params[11],
          idempotency_key: params[12],
          payload: JSON.parse(params[13]),
          blob_refs: JSON.parse(params[14]),
          crdt_refs: JSON.parse(params[15]),
          signature: params[16],
        };
        rows.push(row);
        return { rows: [structuredClone(row)] };
      }
      throw new Error(`unexpected PostgreSQL fixture query: ${normalized}`);
    },
  };
}

async function activateIntent(runtime, intentId, options = {}) {
  await runtime.capture({
    intent_id: intentId,
    statement: options.statement || intentId,
    normalized_objective: options.normalized_objective || intentId,
    project_id: options.project_id || "proj_focus",
    parent_intent_id: options.parent_intent_id,
    return_to_intent_id: options.return_to_intent_id,
  });
  await runtime.transition(intentId, { type: "intent.disambiguated", idempotency_key: `${intentId}:clarified` });
  await runtime.transition(intentId, { type: "intent.planned", idempotency_key: `${intentId}:planned` });
  await runtime.transition(intentId, { type: "intent.execution_started", idempotency_key: `${intentId}:active` });
}

test("capture and restart-safe rehydration preserve bounded canonical fields", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-runtime-capture-"));
  try {
    const runtime = makeRuntime(tempDir, ["2026-07-11T01:00:00.000Z", "2026-07-11T01:00:01.000Z"]);
    const state = await runtime.capture({
      statement: "ship gateway intent runtime",
      normalized_objective: "Ship the canonical intent runtime",
      project_id: "proj_alpha",
      session_id: "sess_1",
      branch_id: "branch_main",
      turn_id: "turn_1",
      broker_event_id: "broker_1",
      surface: "voice",
      transcript_ref: "transcript://voice/1",
      source_receipt_refs: ["receipt://capture/1"],
      completion_criteria: new Array(30).fill("criterion").map((value, index) => `${value}-${index}`),
      active_priorities: ["priority-a", "priority-b", "priority-c"],
      next_step: "write the module",
      sourceReceiptRefs: new Array(40).fill("receipt://capture/overflow"),
    });

    assert.equal(state.intent_id, "intent_0001");
    assert.equal(state.lifecycle_state, "captured");
    assert.equal(state.source.session_id, "sess_1");
    assert.equal(state.completion_criteria.length, 16);
    assert.equal(state.source_receipts.length, 1);
    assert.equal(state.source_receipts[0].source_ref, "turn_1");

    const restarted = makeRuntime(tempDir, ["2026-07-11T01:00:02.000Z"]);
    const rehydrated = await restarted.get("intent_0001");
    assert.equal(rehydrated.normalized_objective, "Ship the canonical intent runtime");
    assert.equal(rehydrated.next_step, "write the module");
    assert.equal(rehydrated.version, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("mutation validation ignores caller limits and terminal intents cannot restart", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-runtime-terminal-"));
  try {
    const runtime = makeRuntime(tempDir, [
      "2026-07-11T02:00:00.000Z",
      "2026-07-11T02:00:01.000Z",
      "2026-07-11T02:00:02.000Z",
    ]);
    await runtime.capture({
      intent_id: "intent_release",
      statement: "finish the release",
      normalized_objective: "Finish the release",
      project_id: "proj_beta",
    });
    await runtime.transition("intent_release", {
      type: "intent.disambiguated",
      next_step: "confirm scope",
    });
    await runtime.transition("intent_release", {
      type: "intent.planned",
      next_step: "execute",
    });
    await runtime.transition("intent_release", {
      type: "intent.execution_started",
    });
    await runtime.transition("intent_release", {
      type: "intent.completed",
      idempotency_key: "complete",
      outcome: "release shipped",
      receipt_refs: ["receipt://release/1"],
    });

    await assert.rejects(
      runtime.transition("intent_release", {
        type: "intent.execution_started",
        idempotency_key: "restart",
        limits: { max_events: 1 },
      }),
      /illegal lifecycle transition/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("duplicate capture cannot reset and same raw idempotency can be reused on different intents", async () => {
  const substrate = makeGlobalIdempotencyFakeSubstrate();
  const runtime = makeRuntime("/tmp/unused", [
    "2026-07-11T03:00:00.000Z",
    "2026-07-11T03:00:01.000Z",
    "2026-07-11T03:00:02.000Z",
  ], substrate);

  await runtime.capture({
    intent_id: "intent_release",
    statement: "finish the release",
    normalized_objective: "Finish the release",
    project_id: "proj_beta",
    idempotency_key: "raw-key",
  });

  await assert.rejects(
    runtime.capture({
      intent_id: "intent_release",
      statement: "mutated payload",
      normalized_objective: "Should fail closed",
      project_id: "proj_beta",
      idempotency_key: "other-key",
    }),
    /intent already exists/,
  );

  await runtime.capture({
    intent_id: "intent_follow_up",
    statement: "follow-up",
    normalized_objective: "Follow-up",
    project_id: "proj_beta",
    idempotency_key: "raw-key",
  });

  const first = await runtime.get("intent_release");
  const second = await runtime.get("intent_follow_up");
  assert.equal(first.statement, "finish the release");
  assert.equal(second.statement, "follow-up");
});

test("capture retries are deterministic across time and occupied malformed streams fail closed", async () => {
  const substrate = makeGlobalIdempotencyFakeSubstrate();
  const runtime = makeRuntime("/tmp/unused", [
    "2026-07-11T03:10:00.000Z",
    "2026-07-11T03:10:30.000Z",
    "2026-07-11T03:11:00.000Z",
  ], substrate);
  const capture = {
    intent_id: "intent_retry",
    statement: "retry safely",
    normalized_objective: "Retry safely",
    project_id: "proj_retry",
    idempotency_key: "capture-retry",
  };
  const first = await runtime.capture(capture);
  const retried = await runtime.capture(capture);
  assert.equal(retried.created_at, first.created_at);
  assert.equal(substrate.events.filter((event) => event.stream_id === "intent:intent_retry").length, 1);
  await assert.rejects(
    runtime.capture({ ...capture, statement: "mutated retry" }),
    /idempotency collision/,
  );

  await substrate.appendEvent({
    event_type: "intent.completed",
    stream_id: "intent:intent_poisoned",
    stream_version: 1,
    idempotency_key: "poisoned-first",
    occurred_at: "2026-07-11T03:12:00.000Z",
    payload: { intent_id: "intent_poisoned", outcome: "invalid first event" },
  });
  await assert.rejects(
    runtime.capture({
      intent_id: "intent_poisoned",
      statement: "must not overwrite",
      normalized_objective: "Must not overwrite",
      idempotency_key: "poisoned-capture",
    }),
    /stream is occupied/,
  );
  assert.equal(substrate.events.filter((event) => event.stream_id === "intent:intent_poisoned").length, 1);
});

test("same-intent Promise.all commands serialize and append explicit expected versions", async () => {
  const substrate = makeGlobalIdempotencyFakeSubstrate();
  const runtime = makeRuntime("/tmp/unused", ["2026-07-11T03:20:00.000Z"], substrate);
  await runtime.capture({
    intent_id: "intent_race",
    statement: "serialize races",
    normalized_objective: "Serialize races",
  });
  const results = await Promise.allSettled([
    runtime.transition("intent_race", { type: "intent.disambiguated", idempotency_key: "race-one", decision: "one" }),
    runtime.transition("intent_race", { type: "intent.disambiguated", idempotency_key: "race-two", decision: "two" }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String(results.find((result) => result.status === "rejected").reason?.message || ""), /illegal lifecycle transition/);
  const stream = substrate.events.filter((event) => event.stream_id === "intent:intent_race");
  assert.deepEqual(stream.map((event) => event.stream_version), [1, 2]);
  assert.equal(stream.filter((event) => event.event_type === "intent.disambiguated").length, 1);

  const exact = await Promise.all([
    runtime.transition("intent_race", { type: "intent.planned", idempotency_key: "same-plan", next_step: "run" }),
    runtime.transition("intent_race", { type: "intent.planned", idempotency_key: "same-plan", next_step: "run" }),
  ]);
  assert.equal(exact[0].lifecycle_state, "planned");
  assert.equal(exact[1].lifecycle_state, "planned");
  assert.equal(substrate.events.filter((event) => event.idempotency_key.endsWith(":same-plan")).length, 1);
});

test("real JSON compare-and-append fails closed across independent runtime instances", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-runtime-real-race-"));
  try {
    const firstStore = createEventSubstrateStore({ dataDir: tempDir, originId: "intent-runtime-test" });
    const secondStore = createEventSubstrateStore({ dataDir: tempDir, originId: "intent-runtime-test" });
    const firstRuntime = makeRuntime(tempDir, ["2026-07-11T03:30:00.000Z"], firstStore);
    const secondRuntime = makeRuntime(tempDir, ["2026-07-11T03:30:00.000Z"], secondStore);
    await firstRuntime.capture({
      intent_id: "intent_cross_runtime_race",
      statement: "cross runtime race",
      normalized_objective: "Cross runtime race",
    });
    const commands = [
      { type: "intent.disambiguated", idempotency_key: "cross-one", decision: "one" },
      { type: "intent.disambiguated", idempotency_key: "cross-two", decision: "two" },
    ];
    const results = await Promise.allSettled([
      firstRuntime.transition("intent_cross_runtime_race", commands[0]),
      secondRuntime.transition("intent_cross_runtime_race", commands[1]),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    const loser = results.find((result) => result.status === "rejected");
    assert.equal(loser.reason?.code, "EVENT_STREAM_VERSION_CONFLICT");
    assert.equal(loser.reason instanceof EventStreamVersionConflictError, true);

    const stored = await firstStore.listEvents({
      stream_id: "intent:intent_cross_runtime_race",
      order: "asc",
      limit: 10,
    });
    assert.deepEqual(stored.map((event) => event.stream_version), [1, 2]);
    assert.equal(stored.filter((event) => event.event_type === "intent.disambiguated").length, 1);

    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
    const retryRuntime = winnerIndex === 0 ? secondRuntime : firstRuntime;
    const retried = await retryRuntime.transition("intent_cross_runtime_race", commands[winnerIndex]);
    assert.deepEqual(retried, results[winnerIndex].value);
    const afterRetry = await secondStore.listEvents({
      stream_id: "intent:intent_cross_runtime_race",
      order: "asc",
      limit: 10,
    });
    assert.deepEqual(afterRetry.map((event) => event.stream_version), [1, 2]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("JSON and PostgreSQL fixtures share substrate-owned compare-and-append semantics", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-substrate-cas-"));
  try {
    const json = createEventSubstrateStore({ dataDir: tempDir, originId: "cas-json" });
    const firstInput = {
      event_type: "intent.captured",
      stream_id: "intent:cas",
      expected_stream_version: 0,
      idempotency_key: "cas-first",
      payload: { intent_id: "cas" },
    };
    const firstJson = await json.appendEvent(firstInput);
    assert.equal(firstJson.stream_version, 1);
    assert.deepEqual(await json.appendEvent(firstInput), firstJson);

    let jsonConflict;
    try {
      await json.appendEvent({ ...firstInput, idempotency_key: "cas-json-conflict" });
    } catch (error) {
      jsonConflict = error;
    }
    assert.equal(jsonConflict instanceof EventStreamVersionConflictError, true);
    assert.equal(jsonConflict.code, "EVENT_STREAM_VERSION_CONFLICT");
    assert.equal(jsonConflict.expected_stream_version, 0);
    assert.equal(jsonConflict.actual_stream_version, 1);

    const autoJson = await json.appendEvent({
      event_type: "intent.enriched",
      stream_id: "intent:cas",
      stream_version: 99,
      idempotency_key: "cas-json-auto",
      payload: { intent_id: "cas" },
    });
    assert.equal(autoJson.stream_version, 2);

    const postgres = makePostgresCompatibleClient();
    const firstPostgres = await appendEventOnClient(postgres, firstInput, { originId: "cas-postgres" });
    assert.equal(firstPostgres.stream_version, 1);
    assert.deepEqual(
      await appendEventOnClient(postgres, firstInput, { originId: "cas-postgres" }),
      firstPostgres,
    );

    postgres.queryKinds.length = 0;
    let postgresConflict;
    try {
      await appendEventOnClient(postgres, { ...firstInput, idempotency_key: "cas-postgres-conflict" }, { originId: "cas-postgres" });
    } catch (error) {
      postgresConflict = error;
    }
    assert.equal(postgresConflict instanceof EventStreamVersionConflictError, true);
    assert.equal(postgresConflict.code, jsonConflict.code);
    assert.equal(postgresConflict.expected_stream_version, 0);
    assert.equal(postgresConflict.actual_stream_version, 1);
    assert.equal(postgres.queryKinds[0], "advisory-lock");
    assert.equal(postgres.queryKinds.includes("version-read"), true);
    assert.equal(postgres.queryKinds.includes("insert"), false);

    const autoPostgres = await appendEventOnClient(postgres, {
      event_type: "intent.enriched",
      stream_id: "intent:cas",
      stream_version: 99,
      idempotency_key: "cas-postgres-auto",
      payload: { intent_id: "cas" },
    }, { originId: "cas-postgres" });
    assert.equal(autoPostgres.stream_version, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("strict lifecycle graph rejects skipped phases", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-runtime-graph-"));
  try {
    const runtime = makeRuntime(tempDir, ["2026-07-11T04:00:00.000Z"]);
    await runtime.capture({
      intent_id: "intent_graph",
      statement: "graph",
      normalized_objective: "graph",
      project_id: "proj_graph",
    });
    await assert.rejects(
      runtime.transition("intent_graph", {
        type: "intent.planned",
        idempotency_key: "skip-clarified",
      }),
      /illegal lifecycle transition/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("relation and focus targets must exist", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-runtime-targets-"));
  try {
    const runtime = makeRuntime(tempDir, ["2026-07-11T05:00:00.000Z"]);
    await runtime.capture({
      intent_id: "intent_parent",
      statement: "parent",
      normalized_objective: "parent",
      project_id: "proj_focus",
    });
    await assert.rejects(
      runtime.connect("intent_parent", {
        relation_type: "blocks",
        target_intent_id: "missing_intent",
      }),
      /target intent not found/,
    );
    await runtime.capture({
      intent_id: "intent_child",
      statement: "child",
      normalized_objective: "child",
      project_id: "proj_focus",
      parent_intent_id: "intent_parent",
      return_to_intent_id: "intent_parent",
    });
    await assert.rejects(
      runtime.pushFocus({
        intent_id: "intent_child",
        parent_intent_id: "intent_parent",
        return_to_intent_id: "missing_intent",
        session_id: "sess_1",
      }),
      /return target intent not found/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("transactional child focus push complete pop restores the parent", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-runtime-focus-"));
  try {
    const runtime = makeRuntime(tempDir, [
      "2026-07-11T06:00:00.000Z",
      "2026-07-11T06:00:01.000Z",
      "2026-07-11T06:00:02.000Z",
      "2026-07-11T06:00:03.000Z",
      "2026-07-11T06:00:04.000Z",
      "2026-07-11T06:00:05.000Z",
      "2026-07-11T06:00:06.000Z",
    ]);

    await runtime.capture({
      intent_id: "intent_parent",
      statement: "change my reply language",
      normalized_objective: "Update language",
      project_id: "proj_gamma",
      session_id: "sess_focus",
      turn_id: "turn_focus_parent",
    });
    await runtime.transition("intent_parent", { type: "intent.disambiguated", idempotency_key: "parent-clarified" });
    await runtime.transition("intent_parent", { type: "intent.planned", idempotency_key: "parent-planned" });
    await runtime.transition("intent_parent", { type: "intent.execution_started", idempotency_key: "parent-active" });
    await runtime.capture({
      intent_id: "intent_child",
      statement: "apply the language change now",
      normalized_objective: "Apply the profile change",
      project_id: "proj_gamma",
      parent_intent_id: "intent_parent",
      return_to_intent_id: "intent_parent",
      session_id: "sess_focus",
      turn_id: "turn_focus_child",
    });
    await runtime.transition("intent_child", { type: "intent.disambiguated", idempotency_key: "child-clarified" });
    await runtime.transition("intent_child", { type: "intent.planned", idempotency_key: "child-planned" });
    await runtime.transition("intent_child", { type: "intent.execution_started", idempotency_key: "child-active" });

    await runtime.pushFocus({
      intent_id: "intent_child",
      session_id: "sess_focus",
      parent_intent_id: "intent_parent",
      return_to_intent_id: "intent_parent",
      idempotency_key: "focus:push",
    });
    await runtime.completeTransactional("intent_child", {
      idempotency_key: "focus:complete",
      outcome: "language changed",
      receipt_refs: ["receipt://profile/version-2"],
      action_refs: ["action://profile/update"],
    });
    const child = await runtime.popFocus({
      intent_id: "intent_child",
      session_id: "sess_focus",
      idempotency_key: "focus:pop",
    });
    const parent = await runtime.get("intent_parent");

    assert.equal(child.lifecycle_state, "completed");
    assert.equal(child.focus_state, "popped");
    assert.equal(child.restored_intent_id, "intent_parent");
    assert.equal(parent.focus_state, "focused");
    assert.equal(parent.focus_child_intent_id, "");
    assert.deepEqual(child.receipt_refs, ["receipt://profile/version-2"]);
    assert.deepEqual(child.action_refs, ["action://profile/update"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("focus push retries either failed half and supports a distinct return target", async () => {
  for (const failedRole of ["suspended", "child"]) {
    const substrate = makeGlobalIdempotencyFakeSubstrate();
    const runtime = makeRuntime("/tmp/unused", ["2026-07-11T06:10:00.000Z"], substrate);
    await activateIntent(runtime, `parent_${failedRole}`);
    await activateIntent(runtime, `return_${failedRole}`);
    await activateIntent(runtime, `child_${failedRole}`, {
      parent_intent_id: `parent_${failedRole}`,
      return_to_intent_id: `return_${failedRole}`,
    });
    let failed = false;
    substrate.setAppendFailure((event) => {
      if (!failed && event.event_type === "intent.focus_pushed" && event.payload.focus_role === failedRole) {
        failed = true;
        return true;
      }
      return false;
    });
    const input = {
      intent_id: `child_${failedRole}`,
      parent_intent_id: `parent_${failedRole}`,
      return_to_intent_id: `return_${failedRole}`,
      session_id: `session_${failedRole}`,
      idempotency_key: `push_${failedRole}`,
    };
    await assert.rejects(runtime.pushFocus(input), /injected append failure/);
    substrate.setAppendFailure(null);
    const child = await runtime.pushFocus(input);
    const parent = await runtime.get(`parent_${failedRole}`);
    const restoredTarget = await runtime.get(`return_${failedRole}`);
    assert.equal(child.focus_state, "focused");
    assert.equal(parent.focus_state, "unfocused");
    assert.equal(restoredTarget.focus_state, "suspended");
    assert.equal(restoredTarget.focus_child_intent_id, `child_${failedRole}`);
    assert.equal(substrate.events.filter((event) => event.idempotency_key.endsWith(`:push_${failedRole}:return`)).length, 1);
    assert.equal(substrate.events.filter((event) => event.idempotency_key.endsWith(`:push_${failedRole}:child`)).length, 1);
  }
});

test("focus push compensates a suspended half when the child becomes terminal before retry", async () => {
  const substrate = makeGlobalIdempotencyFakeSubstrate();
  const runtime = makeRuntime("/tmp/unused", ["2026-07-11T06:15:00.000Z"], substrate);
  await activateIntent(runtime, "parent_compensated");
  await activateIntent(runtime, "child_compensated", {
    parent_intent_id: "parent_compensated",
    return_to_intent_id: "parent_compensated",
  });
  let childHalfFailed = false;
  substrate.setAppendFailure((event) => {
    if (!childHalfFailed && event.event_type === "intent.focus_pushed" && event.payload.focus_role === "child") {
      childHalfFailed = true;
      return true;
    }
    return false;
  });
  const input = {
    intent_id: "child_compensated",
    parent_intent_id: "parent_compensated",
    return_to_intent_id: "parent_compensated",
    session_id: "session_compensated",
    idempotency_key: "push_compensated",
  };
  await assert.rejects(runtime.pushFocus(input), /injected append failure/);
  substrate.setAppendFailure(null);
  assert.equal((await runtime.get("parent_compensated")).focus_state, "suspended");

  await runtime.transition("child_compensated", {
    type: "intent.completed",
    outcome: "completed outside the partial focus pair",
    idempotency_key: "child-completed-before-focus-retry",
  });
  await assert.rejects(
    runtime.pushFocus(input),
    (error) => error?.code === "INTENT_FOCUS_PUSH_COMPENSATED",
  );
  const parent = await runtime.get("parent_compensated");
  const child = await runtime.get("child_compensated");
  assert.equal(parent.focus_state, "focused");
  assert.equal(parent.focus_child_intent_id, "");
  assert.equal(child.lifecycle_state, "completed");
  assert.equal(child.focus_state, "unfocused");
  assert.equal(substrate.events.filter((event) => event.idempotency_key.includes("focus-push-compensate")).length, 1);
  await assert.rejects(
    runtime.pushFocus(input),
    (error) => error?.code === "INTENT_FOCUS_PUSH_COMPENSATED",
  );
  assert.equal(substrate.events.filter((event) => event.idempotency_key.includes("focus-push-compensate")).length, 1);
});

test("focus pop retries either failed half and restores exactly once", async () => {
  for (const failedRole of ["child", "restored"]) {
    const substrate = makeGlobalIdempotencyFakeSubstrate();
    const runtime = makeRuntime("/tmp/unused", ["2026-07-11T06:20:00.000Z"], substrate);
    await activateIntent(runtime, `parent_pop_${failedRole}`);
    await activateIntent(runtime, `return_pop_${failedRole}`);
    await activateIntent(runtime, `child_pop_${failedRole}`, {
      parent_intent_id: `parent_pop_${failedRole}`,
      return_to_intent_id: `return_pop_${failedRole}`,
    });
    await runtime.pushFocus({
      intent_id: `child_pop_${failedRole}`,
      parent_intent_id: `parent_pop_${failedRole}`,
      return_to_intent_id: `return_pop_${failedRole}`,
      session_id: `session_pop_${failedRole}`,
      idempotency_key: `push_pop_${failedRole}`,
    });
    await runtime.completeTransactional(`child_pop_${failedRole}`, {
      outcome: "done",
      receipt_refs: [`receipt://${failedRole}`],
      idempotency_key: `complete_pop_${failedRole}`,
    });
    let failed = false;
    substrate.setAppendFailure((event) => {
      if (!failed && event.event_type === "intent.focus_popped" && event.payload.focus_role === failedRole) {
        failed = true;
        return true;
      }
      return false;
    });
    const input = {
      intent_id: `child_pop_${failedRole}`,
      session_id: `session_pop_${failedRole}`,
      idempotency_key: `pop_${failedRole}`,
    };
    await assert.rejects(runtime.popFocus(input), /injected append failure/);
    substrate.setAppendFailure(null);
    const child = await runtime.popFocus(input);
    const parent = await runtime.get(`parent_pop_${failedRole}`);
    const restoredTarget = await runtime.get(`return_pop_${failedRole}`);
    assert.equal(child.focus_state, "popped");
    assert.equal(child.restored_intent_id, `return_pop_${failedRole}`);
    assert.equal(parent.focus_state, "unfocused");
    assert.equal(restoredTarget.focus_state, "focused");
    assert.equal(restoredTarget.focus_child_intent_id, "");
    assert.equal(substrate.events.filter((event) => event.idempotency_key.endsWith(`:pop_${failedRole}:child`)).length, 1);
    assert.equal(substrate.events.filter((event) => event.idempotency_key.endsWith(`:pop_${failedRole}:return`)).length, 1);
  }
});

test("transactional completion rejects empty normalized receipt refs", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-runtime-focus-receipt-"));
  try {
    const runtime = makeRuntime(tempDir, [
      "2026-07-11T07:00:00.000Z",
      "2026-07-11T07:00:01.000Z",
      "2026-07-11T07:00:02.000Z",
      "2026-07-11T07:00:03.000Z",
    ]);

    await runtime.capture({
      intent_id: "intent_parent",
      statement: "parent intent",
      normalized_objective: "Parent intent",
      project_id: "proj_receipts",
    });
    await runtime.transition("intent_parent", { type: "intent.disambiguated", idempotency_key: "p-clarified" });
    await runtime.transition("intent_parent", { type: "intent.planned", idempotency_key: "p-planned" });
    await runtime.transition("intent_parent", { type: "intent.execution_started", idempotency_key: "p-active" });
    await runtime.capture({
      intent_id: "intent_child",
      statement: "child intent",
      normalized_objective: "Child intent",
      project_id: "proj_receipts",
      parent_intent_id: "intent_parent",
      return_to_intent_id: "intent_parent",
    });
    await runtime.transition("intent_child", { type: "intent.disambiguated", idempotency_key: "c-clarified" });
    await runtime.transition("intent_child", { type: "intent.planned", idempotency_key: "c-planned" });
    await runtime.transition("intent_child", { type: "intent.execution_started", idempotency_key: "c-active" });
    await runtime.pushFocus({
      intent_id: "intent_child",
      session_id: "sess_receipts",
      parent_intent_id: "intent_parent",
      return_to_intent_id: "intent_parent",
    });

    await assert.rejects(
      runtime.completeTransactional("intent_child", {
        receipt_refs: ["", "   "],
        outcome: "should fail closed",
      }),
      /transactional completion requires at least one receipt_ref/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("oversized mutation history fails closed, huge read limits clamp, and project rehydration stays bounded", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-runtime-pagination-"));
  try {
    const runtime = makeRuntime(tempDir, ["2026-07-11T08:00:00.000Z"]);
    const state = await runtime.capture({
      intent_id: "intent_long",
      statement: "long running intent history",
      normalized_objective: "Exercise event pagination",
      project_id: "proj_delta",
    });

    const store = createEventSubstrateStore({ dataDir: tempDir, originId: "intent-runtime-test" });
    for (let index = 0; index < 2_100; index += 1) {
      await store.appendEvent({
        event_type: "intent.enriched",
        stream_id: `intent:${state.intent_id}`,
        idempotency_key: `enrich:${index}`,
        occurred_at: `2026-07-11T08:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        payload: {
          intent_id: state.intent_id,
          decision: `decision-${index}`,
          source_receipt_refs: new Array(50).fill(`receipt://${index}`),
        },
      });
    }

    await assert.rejects(
      runtime.transition("intent_long", {
        type: "intent.disambiguated",
        idempotency_key: "should-fail",
      }),
      /history exceeds mutation bound/,
    );

    const bounded = await runtime.rehydrate({ intent_id: state.intent_id, max_events: 1000000 });
    assert.equal(bounded.limits.max_events, 2000);
    assert.equal(bounded.truncation.truncated, true);

    const project = await runtime.rehydrate({ project_id: "proj_delta", limit: 1000000, max_events: 1000000 });
    assert.equal(project.limits.limit, 500);
    assert.equal(project.total_count, null);
    assert.equal(project.total_count_lower_bound, 1);
    assert.equal(project.intents[0].source_receipts.length <= 20, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay preserves unknown-event diagnostics and rejects malformed or cross-stream recognized events", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-runtime-replay-"));
  try {
    const store = createEventSubstrateStore({ dataDir: tempDir, originId: "intent-runtime-test" });
    await store.appendEvent({
      event_type: "intent.completed",
      stream_id: "intent:intent_bad",
      idempotency_key: "bad-complete",
      occurred_at: "2026-07-11T09:00:00.000Z",
      payload: {
        intent_id: "intent_bad",
        outcome: "wrong order",
      },
    });
    await store.appendEvent({
      event_type: "intent.future_extension",
      stream_id: "intent:intent_bad",
      idempotency_key: "future",
      occurred_at: "2026-07-11T09:00:01.000Z",
      payload: {
        intent_id: "intent_bad",
      },
    });
    await store.appendEvent({
      event_type: "intent.captured",
      stream_id: "intent:intent_cross",
      idempotency_key: "cross-capture",
      occurred_at: "2026-07-11T09:00:02.000Z",
      payload: {
        intent_id: "someone_else",
        statement: "cross",
        normalized_objective: "cross",
      },
    });

    const runtime = makeRuntime(tempDir, ["2026-07-11T09:00:03.000Z"]);
    const malformed = await runtime.get("intent_bad");
    assert.equal(malformed.exists, false);
    assert.equal(malformed.diagnostics.some((item) => /must begin with intent\.captured/.test(item.detail)), true);
    assert.equal(malformed.diagnostics.some((item) => /ignored forward-compatible event/.test(item.detail)), true);

    const cross = await runtime.get("intent_cross");
    assert.equal(cross.exists, false);
    assert.equal(cross.diagnostics.some((item) => /does not match stream/.test(item.detail)), true);

    await assert.rejects(
      runtime.transition("intent_bad", {
        type: "intent.disambiguated",
        idempotency_key: "bad-mutate",
      }),
      /intent stream must begin with intent\.captured/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("strict replay rejects missing identity, early lessons, malformed relations, and premature focus", async () => {
  const substrate = makeGlobalIdempotencyFakeSubstrate();
  const captured = (intentId, idempotencyKey) => substrate.appendEvent({
    event_type: "intent.captured",
    stream_id: `intent:${intentId}`,
    stream_version: 1,
    idempotency_key: idempotencyKey,
    occurred_at: "2026-07-11T09:10:00.000Z",
    payload: { intent_id: intentId, statement: intentId, normalized_objective: intentId },
  });
  await substrate.appendEvent({
    event_type: "intent.captured",
    stream_id: "intent:missing_identity",
    stream_version: 1,
    idempotency_key: "missing-identity-capture",
    occurred_at: "2026-07-11T09:10:00.000Z",
    payload: { statement: "missing", normalized_objective: "missing" },
  });
  await captured("early_lesson", "early-lesson-capture");
  await substrate.appendEvent({
    event_type: "intent.lesson_recorded",
    stream_id: "intent:early_lesson",
    stream_version: 2,
    idempotency_key: "early-lesson-event",
    occurred_at: "2026-07-11T09:10:01.000Z",
    payload: { intent_id: "early_lesson", lesson: "too early" },
  });
  await captured("missing_relation", "missing-relation-capture");
  await substrate.appendEvent({
    event_type: "intent.connected",
    stream_id: "intent:missing_relation",
    stream_version: 2,
    idempotency_key: "missing-relation-event",
    occurred_at: "2026-07-11T09:10:01.000Z",
    payload: { intent_id: "missing_relation", relation_type: "blocks" },
  });
  await captured("absent_relation", "absent-relation-capture");
  await substrate.appendEvent({
    event_type: "intent.connected",
    stream_id: "intent:absent_relation",
    stream_version: 2,
    idempotency_key: "absent-relation-event",
    occurred_at: "2026-07-11T09:10:01.000Z",
    payload: { intent_id: "absent_relation", relation_type: "blocks", target_intent_id: "never_captured" },
  });
  await captured("focus_target", "focus-target-capture");
  await captured("premature_focus", "premature-focus-capture");
  await substrate.appendEvent({
    event_type: "intent.focus_pushed",
    stream_id: "intent:premature_focus",
    stream_version: 2,
    idempotency_key: "premature-focus-event",
    occurred_at: "2026-07-11T09:10:01.000Z",
    payload: {
      intent_id: "premature_focus",
      session_id: "sess_bad",
      parent_intent_id: "focus_target",
      return_to_intent_id: "focus_target",
      child_intent_id: "premature_focus",
      focus_role: "child",
    },
  });

  const runtime = makeRuntime("/tmp/unused", ["2026-07-11T09:10:02.000Z"], substrate);
  for (const [intentId, detail] of [
    ["missing_identity", /payload intent_id is required/],
    ["early_lesson", /illegal lifecycle transition/],
    ["missing_relation", /target_intent_id is required/],
    ["absent_relation", /relation target intent not found/],
    ["premature_focus", /focus push requires active lifecycle/],
  ]) {
    const publicState = await runtime.get(intentId);
    assert.equal(publicState.diagnostics.some((item) => detail.test(item.detail)), true, intentId);
    await assert.rejects(
      runtime.transition(intentId, { type: "intent.disambiguated", idempotency_key: `mutate-${intentId}` }),
      detail,
    );
  }
});

test("append result mismatch and overlong identifiers fail closed", async () => {
  const mismatchedSubstrate = {
    async appendEvent(input = {}) {
      return {
        ...structuredClone(input),
        stream_id: "intent:someone-else",
      };
    },
    async listEvents() {
      return [];
    },
  };
  const runtime = makeRuntime("/tmp/unused", ["2026-07-11T10:00:00.000Z"], mismatchedSubstrate);
  await assert.rejects(
    runtime.capture({
      intent_id: "intent_x",
      statement: "x",
      normalized_objective: "x",
      project_id: "proj_x",
    }),
    /append result mismatch/,
  );

  const tooLong = `intent_${"x".repeat(200)}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-runtime-length-"));
  try {
    const checked = makeRuntime(tempDir, ["2026-07-11T10:00:01.000Z"]);
    await assert.rejects(
      checked.capture({
        intent_id: tooLong,
        statement: "x",
        normalized_objective: "x",
        project_id: "proj_x",
      }),
      /intent_id exceeds max length/,
    );
    await assert.rejects(
      checked.capture({
        intent_id: "intent_ok",
        statement: "x",
        normalized_objective: "x",
        project_id: "proj_x",
        idempotency_key: "k".repeat(181),
      }),
      /idempotency_key exceeds max length/,
    );

    const exactIntentId = "i".repeat(160);
    const exactProjectId = "p".repeat(160);
    await checked.capture({
      intent_id: exactIntentId,
      statement: "bounded read target",
      normalized_objective: "Bounded read target",
      project_id: exactProjectId,
      idempotency_key: "bounded-read-capture",
    });
    for (const request of [
      () => checked.get(`${exactIntentId}x`),
      () => checked.rehydrate({ intent_id: `${exactIntentId}x` }),
      () => checked.rehydrate({ project_id: `${exactProjectId}x` }),
      () => checked.list({ project_id: `${exactProjectId}x` }),
      () => checked.list({ session_id: "s".repeat(161) }),
    ]) {
      await assert.rejects(request(), /exceeds max length/);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
