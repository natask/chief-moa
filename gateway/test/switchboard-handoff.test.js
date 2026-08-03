"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  captureBlockEnvelope,
  createSwitchboardHandoffService,
} = require("../lib/switchboard-handoff");
const { createSwitchboardHandoffHandlers } = require("../lib/switchboard-handoff-handlers");

const ID = `cap_${"a".repeat(64)}`;
const BLOCK = {
  schema_version: 1,
  id: ID,
  literal_transcript: "Ship the smallest safe handoff.\n",
  audio: { storage_ref: "voice-sessions/session/turn.pcm" },
};
const AUDIO_BLOCK = {
  schema_version: 2,
  id: `cap_${"b".repeat(64)}`,
  processing_state: "transcribed",
  source: { kind: "audio_note", audio_note_id: "note_audio_1" },
  audio: {
    audio_note_id: "note_audio_1",
    href: "/v1/audio-notes/note_audio_1/audio",
    content_type: "audio/webm;codecs=opus",
  },
  transcript: {
    state: "transcribed",
    literal: " Keep these exact spoken words.\n",
    result_id: "literal_result_1",
    provider: { id: "chirp", model: "chirp_3", request_id: "provider_request_1" },
  },
};
const V2_FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "external-intent-v2.json"),
  "utf8",
));

function eventMemory() {
  const rows = [];
  let lock = Promise.resolve();
  return {
    rows,
    appendEvent: async (event) => {
      const prior = rows.find((row) => row.idempotency_key === event.idempotency_key);
      if (prior) return prior;
      const stored = { ...event, event_id: `evt_${rows.length + 1}` };
      rows.push(stored);
      return stored;
    },
    listEvents: async (filter) => rows.filter((row) =>
      (!filter.stream_id || row.stream_id === filter.stream_id)
      && (!filter.event_type || row.event_type === filter.event_type)),
    withStreamLock: async (_streamId, fn) => {
      const previous = lock;
      let release;
      lock = new Promise((resolve) => { release = resolve; });
      await previous;
      try { return await fn(); } finally { release(); }
    },
  };
}

function switchboardAdmission(envelope) {
  return {
    admission: {
      id: "ext_1",
      contractVersion: envelope.contract_version,
      rawIntentId: "raw_1",
      messageId: "msg_1",
      sourceSystem: envelope.source_system,
      sourceRecordId: envelope.source_record_id,
      sourceRevision: envelope.source_revision,
      sourceHash: envelope.source_hash,
      exactText: envelope.exact_text,
      evidenceRefs: envelope.evidence_refs,
      contextRefs: envelope.context_refs,
      projectHint: envelope.project_hint,
      authority: envelope.authority,
      idempotencyKey: envelope.idempotency_key,
      ...(envelope.contract_version === 2 ? {
        desiredOutcome: envelope.desired_outcome,
        acceptanceCriteria: envelope.acceptance_criteria,
      } : {}),
      state: "queued",
      compiledIntents: [{ intentId: "intent_1" }],
    },
  };
}

test("capture block envelope has stable revision, hash, authority, and idempotency", () => {
  const first = captureBlockEnvelope({ captureBlock: BLOCK });
  const second = captureBlockEnvelope({ captureBlock: { ...BLOCK } });
  assert.deepEqual(first, second);
  assert.equal(first.contract_version, 1);
  assert.equal(first.authority, "execute");
  assert.match(first.source_revision, /^capture-block-v1:[a-f0-9]{64}$/);
  assert.match(first.source_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.exact_text, BLOCK.literal_transcript);
  assert.equal(first.evidence_refs[0].id, ID);
});

test("transcribed audio-backed envelope binds the immutable result and keeps audio opaque", () => {
  const first = captureBlockEnvelope({ captureBlock: AUDIO_BLOCK });
  const retry = captureBlockEnvelope({ captureBlock: structuredClone(AUDIO_BLOCK) });
  assert.deepEqual(retry, first);
  assert.match(first.source_revision, /^capture-block-v2:[a-f0-9]{64}$/);
  assert.equal(first.source_hash, `sha256:${first.source_revision.split(":")[1]}`);
  assert.equal(first.exact_text, AUDIO_BLOCK.transcript.literal);
  assert.deepEqual(first.evidence_refs, [
    { type: "capture_block", id: AUDIO_BLOCK.id },
    { type: "audio_note", id: "note_audio_1" },
    {
      type: "transcript_result",
      id: "literal_result_1",
      provider: { id: "chirp", model: "chirp_3", request_id: "provider_request_1" },
    },
  ]);
  assert.equal(JSON.stringify(first.evidence_refs).includes(AUDIO_BLOCK.audio.href), false);

  for (const mutate of [
    (block) => { block.transcript.literal += " changed"; },
    (block) => { block.transcript.result_id = "literal_result_2"; },
    (block) => { block.transcript.provider.request_id = "provider_request_2"; },
    (block) => { block.source.audio_note_id = block.audio.audio_note_id = "note_audio_2"; },
  ]) {
    const changed = structuredClone(AUDIO_BLOCK);
    mutate(changed);
    const envelope = captureBlockEnvelope({ captureBlock: changed });
    assert.notEqual(envelope.source_revision, first.source_revision);
    assert.notEqual(envelope.source_hash, first.source_hash);
    assert.notEqual(envelope.idempotency_key, first.idempotency_key);
  }
});

test("confirmed goal handoff upgrades to v2 without changing source evidence", () => {
  const v1 = captureBlockEnvelope({ captureBlock: AUDIO_BLOCK });
  const v2 = captureBlockEnvelope({
    captureBlock: AUDIO_BLOCK,
    desired_outcome: "Ship a durable selected-note handoff.",
    acceptance_criteria: [
      "The selected source remains replayable.",
      "One confirmed handoff creates one canonical intent.",
      "The selected source remains replayable.",
    ],
  });
  assert.equal(v1.contract_version, 1);
  assert.equal(v2.contract_version, 2);
  assert.equal(v2.source_revision, v1.source_revision);
  assert.equal(v2.source_hash, v1.source_hash);
  assert.equal(v2.exact_text, v1.exact_text);
  assert.equal(v2.desired_outcome, "Ship a durable selected-note handoff.");
  assert.deepEqual(v2.acceptance_criteria, [
    "The selected source remains replayable.",
    "One confirmed handoff creates one canonical intent.",
  ]);
});

test("cross-product v2 fixture preserves the exact Switchboard seam", async () => {
  const events = eventMemory();
  let observed;
  const service = createSwitchboardHandoffService({
    events,
    baseUrl: "http://switchboard.test",
    fetchImpl: async (_url, init) => {
      observed = JSON.parse(init.body);
      return { ok: true, status: 202, json: async () => ({ admission: {
        ...V2_FIXTURE.admission,
        id: "admission_fixture_1",
        rawIntentId: "raw_fixture_1",
        messageId: "message_fixture_1",
        state: "queued",
        compiledIntents: [{ intentId: "intent_fixture_1" }],
      } }) };
    },
  });
  const fixtureBlock = {
    ...structuredClone(AUDIO_BLOCK),
    id: V2_FIXTURE.request.source_record_id,
    source: { kind: "audio_note", audio_note_id: "note_fixture_1" },
    audio: { ...AUDIO_BLOCK.audio, audio_note_id: "note_fixture_1" },
    transcript: {
      state: "transcribed",
      literal: V2_FIXTURE.request.exact_text,
      result_id: "result_fixture_1",
      provider: { id: "fixture-stt", model: "fixture-model", request_id: "fixture-request-1" },
    },
  };
  const receipt = await service.handoffCaptureBlock({
    captureBlock: fixtureBlock,
    confirmed: true,
    authority: "execute",
    desired_outcome: V2_FIXTURE.request.desired_outcome,
    acceptance_criteria: V2_FIXTURE.request.acceptance_criteria,
    project_hint: V2_FIXTURE.request.project_hint,
  });
  assert.deepEqual(observed, V2_FIXTURE.request);
  assert.equal(receipt.desired_outcome, V2_FIXTURE.admission.desiredOutcome);
  assert.deepEqual(receipt.acceptance_criteria, V2_FIXTURE.admission.acceptanceCriteria);
});

test("v2 goal fields are explicit, bounded, and confirmed together", () => {
  for (const input of [
    { desired_outcome: "outcome" },
    { acceptance_criteria: ["criterion"] },
    { desired_outcome: "", acceptance_criteria: ["criterion"] },
    { desired_outcome: "x".repeat(100_001), acceptance_criteria: ["criterion"] },
    { desired_outcome: "outcome", acceptance_criteria: [] },
    { desired_outcome: "outcome", acceptance_criteria: Array.from({ length: 33 }, (_, index) => `criterion ${index}`) },
    { desired_outcome: "outcome", acceptance_criteria: ["x".repeat(1_001)] },
  ]) assert.throws(() => captureBlockEnvelope({ captureBlock: AUDIO_BLOCK, ...input }));
});

test("audio-backed handoff rejects unfinished or unprovable transcription projections before network", async () => {
  let networkCalls = 0;
  const service = createSwitchboardHandoffService({
    events: eventMemory(),
    baseUrl: "http://switchboard.test",
    fetchImpl: async () => { networkCalls += 1; throw new Error("must not call"); },
  });
  for (const state of ["queued", "transcribing", "failed"]) {
    const captureBlock = {
      ...structuredClone(AUDIO_BLOCK),
      processing_state: state,
      transcript: { ...AUDIO_BLOCK.transcript, state },
    };
    assert.throws(() => captureBlockEnvelope({ captureBlock }), /must be transcribed/);
    await assert.rejects(
      service.handoffCaptureBlock({
        captureBlock,
        confirmed: true,
        authority: "execute",
      }),
      /must be transcribed/,
    );
  }
  for (const mutate of [
    (block) => { block.transcript.state = "queued"; },
    (block) => { block.source.kind = "voice_turn"; },
    (block) => { block.source.audio_note_id = "note_other"; },
    (block) => { block.transcript.result_id = ""; },
    (block) => { block.transcript.provider = null; },
    (block) => { block.transcript.provider.id = ""; },
  ]) {
    const changed = structuredClone(AUDIO_BLOCK);
    mutate(changed);
    assert.throws(() => captureBlockEnvelope({ captureBlock: changed }));
  }
  assert.equal(networkCalls, 0);
});

test("handoff requires explicit confirmation and execute authority before network or persistence", async () => {
  const events = eventMemory();
  let calls = 0;
  const service = createSwitchboardHandoffService({
    events,
    baseUrl: "http://switchboard.test",
    fetchImpl: async () => { calls += 1; throw new Error("must not call"); },
  });
  await assert.rejects(service.handoffCaptureBlock({ captureBlock: BLOCK, authority: "execute" }), /explicit user confirmation/);
  await assert.rejects(service.handoffCaptureBlock({ captureBlock: BLOCK, confirmed: true, authority: "capture" }), /authority='execute'/);
  assert.equal(calls, 0);
  assert.equal(events.rows.length, 0);
});

test("handoff configuration and unsupported source schemas fail closed", async () => {
  assert.throws(() => createSwitchboardHandoffService(), /event substrate/);
  assert.throws(() => createSwitchboardHandoffService({
    events: { appendEvent() {}, listEvents() {} },
  }), /stream locking/);
  assert.throws(() => createSwitchboardHandoffService({
    events: { appendEvent() {}, listEvents() {}, withStreamLock() {} },
    fetchImpl: "invalid",
  }), /requires fetch/);
  assert.throws(
    () => captureBlockEnvelope({ captureBlock: { ...BLOCK, schema_version: 3 } }),
    /schema version is unsupported/,
  );
  const service = createSwitchboardHandoffService({ events: eventMemory() });
  await assert.rejects(service.handoffCaptureBlock({
    captureBlock: BLOCK, confirmed: true, authority: "execute",
  }), (error) => error.statusCode === 503 && error.code === "unavailable");
});

test("concurrent retry dispatches once and returns one continuity receipt without storing source text", async () => {
  const events = eventMemory();
  const requests = [];
  const service = createSwitchboardHandoffService({
    events,
    baseUrl: "http://switchboard.test/",
    token: "secret",
    fetchImpl: async (url, init) => {
      const envelope = JSON.parse(init.body);
      requests.push({ url, init, envelope });
      return { ok: true, status: 202, json: async () => switchboardAdmission(envelope) };
    },
  });
  const input = {
    captureBlock: BLOCK,
    confirmed: true,
    authority: "execute",
    context_refs: [{ type: "context_packet", id: "context_1", bounds: [1, 2] }],
  };
  const [first, retry] = await Promise.all([
    service.handoffCaptureBlock(input),
    service.handoffCaptureBlock(input),
  ]);
  assert.deepEqual(retry, first);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://switchboard.test/api/v1/external-intents");
  assert.equal(requests[0].init.headers.authorization, "Bearer secret");
  assert.equal(first.switchboard.admission_id, "ext_1");
  assert.deepEqual(first.switchboard.compiled_intent_ids, ["intent_1"]);
  assert.equal(events.rows.length, 1);
  assert.equal(JSON.stringify(events.rows).includes(BLOCK.literal_transcript), false);
  assert.match(first.request_digest, /^sha256:[a-f0-9]{64}$/);
});

test("a changed request for the same source revision conflicts with its retained receipt", async () => {
  const events = eventMemory();
  let requests = 0;
  const service = createSwitchboardHandoffService({
    events,
    baseUrl: "http://switchboard.test",
    fetchImpl: async (_url, init) => {
      requests += 1;
      const envelope = JSON.parse(init.body);
      return { ok: true, status: 202, json: async () => switchboardAdmission(envelope) };
    },
  });
  const base = { captureBlock: BLOCK, confirmed: true, authority: "execute" };
  await service.handoffCaptureBlock({ ...base, project_hint: "project-a" });
  await assert.rejects(
    service.handoffCaptureBlock({ ...base, project_hint: "project-b" }),
    (error) => error.statusCode === 409 && error.code === "conflict",
  );
  await assert.rejects(
    service.handoffCaptureBlock({ ...base, project_hint: "project-a", context_refs: [{ id: "changed" }] }),
    (error) => error.statusCode === 409 && error.code === "conflict",
  );
  assert.equal(requests, 1);
  assert.equal(events.rows.length, 1);
});

test("audio-backed concurrent retry dispatches once and stores no transcript or media provenance", async () => {
  const events = eventMemory();
  const requests = [];
  const service = createSwitchboardHandoffService({
    events,
    baseUrl: "http://switchboard.test",
    fetchImpl: async (_url, init) => {
      const envelope = JSON.parse(init.body);
      requests.push(envelope);
      return { ok: true, status: 202, json: async () => switchboardAdmission(envelope) };
    },
  });
  const input = { captureBlock: AUDIO_BLOCK, confirmed: true, authority: "execute" };
  const [first, retry] = await Promise.all([
    service.handoffCaptureBlock(input),
    service.handoffCaptureBlock(input),
  ]);
  assert.deepEqual(retry, first);
  assert.equal(requests.length, 1);
  assert.equal(events.rows.length, 1);
  const retainedReceipt = JSON.stringify(events.rows[0].payload);
  for (const forbidden of [
    AUDIO_BLOCK.transcript.literal,
    AUDIO_BLOCK.transcript.result_id,
    AUDIO_BLOCK.transcript.provider.request_id,
    AUDIO_BLOCK.audio.audio_note_id,
    AUDIO_BLOCK.audio.href,
  ]) assert.equal(retainedReceipt.includes(forbidden), false);
});

test("v2 receipt binds and retains the confirmed outcome and acceptance gate", async () => {
  const events = eventMemory();
  const requests = [];
  const service = createSwitchboardHandoffService({
    events,
    baseUrl: "http://switchboard.test",
    fetchImpl: async (_url, init) => {
      const envelope = JSON.parse(init.body);
      requests.push(envelope);
      return { ok: true, status: 202, json: async () => switchboardAdmission(envelope) };
    },
  });
  const input = {
    captureBlock: AUDIO_BLOCK,
    confirmed: true,
    authority: "execute",
    desired_outcome: "Complete the selected product outcome.",
    acceptance_criteria: ["The exact selected source is bound.", "Completion has evidence."],
  };
  const receipt = await service.handoffCaptureBlock(input);
  assert.equal(requests[0].contract_version, 2);
  assert.equal(receipt.schema_version, 2);
  assert.equal(receipt.contract_version, 2);
  assert.equal(receipt.desired_outcome, input.desired_outcome);
  assert.deepEqual(receipt.acceptance_criteria, input.acceptance_criteria);
  assert.equal(events.rows[0].payload.desired_outcome, input.desired_outcome);

  const changed = { ...input, desired_outcome: "A different outcome." };
  await assert.rejects(
    service.handoffCaptureBlock(changed),
    (error) => error.statusCode === 409 && error.code === "conflict",
  );
  assert.equal(requests.length, 1);
});

test("v2 rejects altered goal admission without retaining a receipt", async () => {
  for (const mutate of [
    (admission) => { admission.desiredOutcome = "substituted"; },
    (admission) => { admission.acceptanceCriteria = ["substituted"]; },
  ]) {
    const events = eventMemory();
    const service = createSwitchboardHandoffService({
      events,
      baseUrl: "http://switchboard.test",
      fetchImpl: async (_url, init) => {
        const response = switchboardAdmission(JSON.parse(init.body));
        mutate(response.admission);
        return { ok: true, status: 202, json: async () => response };
      },
    });
    await assert.rejects(service.handoffCaptureBlock({
      captureBlock: AUDIO_BLOCK,
      confirmed: true,
      authority: "execute",
      desired_outcome: "Bound outcome",
      acceptance_criteria: ["Bound criterion"],
    }), /mismatched admission receipt/);
    assert.equal(events.rows.length, 0);
  }
});

test("audio-backed mismatched Switchboard evidence is rejected without a receipt", async () => {
  const events = eventMemory();
  const service = createSwitchboardHandoffService({
    events,
    baseUrl: "http://switchboard.test",
    fetchImpl: async (_url, init) => {
      const envelope = JSON.parse(init.body);
      const response = switchboardAdmission(envelope);
      response.admission.evidenceRefs[1].id = "note_substituted";
      return { ok: true, status: 202, json: async () => response };
    },
  });
  await assert.rejects(
    service.handoffCaptureBlock({ captureBlock: AUDIO_BLOCK, confirmed: true, authority: "execute" }),
    /mismatched admission receipt/,
  );
  assert.equal(events.rows.length, 0);
});

test("mismatched Switchboard receipt is rejected and not persisted", async () => {
  const events = eventMemory();
  const service = createSwitchboardHandoffService({
    events,
    baseUrl: "http://switchboard.test",
    fetchImpl: async (_url, init) => {
      const envelope = JSON.parse(init.body);
      const response = switchboardAdmission(envelope);
      response.admission.sourceRecordId = "other";
      return { ok: true, status: 202, json: async () => response };
    },
  });
  await assert.rejects(
    service.handoffCaptureBlock({ captureBlock: BLOCK, confirmed: true, authority: "execute" }),
    /mismatched admission receipt/,
  );
  assert.equal(events.rows.length, 0);
});

test("altered admitted text or provenance is rejected", async () => {
  for (const mutate of [
    (admission) => { admission.exactText = "changed"; },
    (admission) => { admission.contextRefs = ["changed"]; },
    (admission) => { admission.evidenceRefs = []; },
    (admission) => { admission.projectHint = "changed"; },
  ]) {
    const events = eventMemory();
    const service = createSwitchboardHandoffService({
      events,
      baseUrl: "http://switchboard.test",
      fetchImpl: async (_url, init) => {
        const envelope = JSON.parse(init.body);
        const response = switchboardAdmission(envelope);
        mutate(response.admission);
        return { ok: true, status: 202, json: async () => response };
      },
    });
    await assert.rejects(service.handoffCaptureBlock({
      captureBlock: BLOCK, confirmed: true, authority: "execute",
    }), /mismatched admission receipt/);
    assert.equal(events.rows.length, 0);
  }
});

test("malformed Switchboard identities are upstream failures", async () => {
  for (const mutate of [
    (admission) => { delete admission.id; },
    (admission) => { admission.rawIntentId = {}; },
    (admission) => { admission.compiledIntents = [{ intentId: {} }]; },
  ]) {
    const events = eventMemory();
    const service = createSwitchboardHandoffService({
      events,
      baseUrl: "http://switchboard.test",
      fetchImpl: async (_url, init) => {
        const response = switchboardAdmission(JSON.parse(init.body));
        mutate(response.admission);
        return { ok: true, status: 202, json: async () => response };
      },
    });
    await assert.rejects(
      service.handoffCaptureBlock({ captureBlock: BLOCK, confirmed: true, authority: "execute" }),
      (error) => error.statusCode === 502 && error.code === "upstream",
    );
    assert.equal(events.rows.length, 0);
  }
});

test("stalled Switchboard response fails at a bounded deadline", async () => {
  const service = createSwitchboardHandoffService({
    events: eventMemory(),
    baseUrl: "http://switchboard.test",
    timeoutMs: 5,
    fetchImpl: async () => new Promise(() => {}),
  });
  await assert.rejects(service.handoffCaptureBlock({
    captureBlock: BLOCK, confirmed: true, authority: "execute",
  }), /timed out/);
});

test("Switchboard transport and response failures are bounded upstream errors", async () => {
  const fetchCases = [
    async () => { throw new Error("offline"); },
    async () => ({ ok: false, status: 409, json: async () => ({}) }),
    async () => ({ ok: true, status: 202, json: async () => { throw new Error("bad json"); } }),
    async () => ({ ok: true, status: 202, json: async () => ({}) }),
  ];
  for (const fetchImpl of fetchCases) {
    const service = createSwitchboardHandoffService({
      events: eventMemory(), baseUrl: "http://switchboard.test", fetchImpl,
    });
    await assert.rejects(service.handoffCaptureBlock({
      captureBlock: BLOCK, confirmed: true, authority: "execute",
    }), (error) => error.statusCode === 502 && error.code === "upstream");
  }
});

test("opaque context references are bounded and JSON-safe", () => {
  const valid = captureBlockEnvelope({
    captureBlock: BLOCK,
    context_refs: [null, true, 2, "opaque", { nested: ["value"] }],
  });
  assert.deepEqual(valid.context_refs, [null, true, 2, "opaque", { nested: ["value"] }]);
  for (const context_refs of [
    "not-an-array",
    Array.from({ length: 21 }, () => "x"),
    [Number.NaN],
    [new Date()],
    [[[[[[[["too deep"]]]]]]]],
    [{ value: "x".repeat(33 * 1024) }],
  ]) assert.throws(() => captureBlockEnvelope({ captureBlock: BLOCK, context_refs }));
});

test("authenticated handler resolves the stored block and preserves inert GET routes", async () => {
  const calls = [];
  const handlers = createSwitchboardHandoffHandlers({
    authorized: () => true,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    readJsonBody: async () => ({ confirmed: true, authority: "execute" }),
    captureBlocks: { get: async (id) => { calls.push(["get", id]); return BLOCK; } },
    handoffs: { handoffCaptureBlock: async (input) => { calls.push(["handoff", input]); return { request_digest: "sha256:x" }; } },
  });
  assert.equal(await handlers.routeSwitchboardHandoffs(
    { method: "GET" }, {}, new URL(`/v1/capture-blocks/${ID}`, "https://gateway.test"),
  ), false);
  const response = {};
  assert.equal(await handlers.routeSwitchboardHandoffs(
    { method: "POST" }, response, new URL(`/v1/capture-blocks/${ID}/handoff`, "https://gateway.test"),
  ), true);
  assert.equal(response.status, 202);
  assert.deepEqual(calls[0], ["get", ID]);
  assert.equal(calls[1][1].captureBlock, BLOCK);
});

test("handler rejects unauthenticated, missing, malformed, and unconfirmed handoffs", async () => {
  const sendJson = (response, status, payload) => Object.assign(response, { status, payload });
  let handlers = createSwitchboardHandoffHandlers({
    authorized: () => false, sendJson, readJsonBody: async () => ({}),
    captureBlocks: { get: async () => BLOCK }, handoffs: {},
  });
  let response = {};
  await handlers.routeSwitchboardHandoffs(
    { method: "POST" }, response, new URL(`/v1/capture-blocks/${ID}/handoff`, "https://gateway.test"),
  );
  assert.equal(response.status, 401);

  handlers = createSwitchboardHandoffHandlers({
    authorized: () => true, sendJson, readJsonBody: async () => ({}),
    captureBlocks: { get: async () => null }, handoffs: {},
  });
  response = {};
  await handlers.routeSwitchboardHandoffs(
    { method: "POST" }, response, new URL(`/v1/capture-blocks/${ID}/handoff`, "https://gateway.test"),
  );
  assert.equal(response.status, 404);

  handlers = createSwitchboardHandoffHandlers({
    authorized: () => true, sendJson, readJsonBody: async () => ({ confirmed: false, authority: "execute" }),
    captureBlocks: { get: async () => BLOCK },
    handoffs: { handoffCaptureBlock: async () => { throw Object.assign(new Error("explicit user confirmation is required"), { statusCode: 400 }); } },
  });
  response = {};
  await handlers.routeSwitchboardHandoffs(
    { method: "POST" }, response, new URL(`/v1/capture-blocks/${ID}/handoff`, "https://gateway.test"),
  );
  assert.equal(response.status, 400);

  handlers = createSwitchboardHandoffHandlers({
    authorized: () => true, sendJson, readJsonBody: async () => ({ confirmed: true, authority: "execute" }),
    captureBlocks: { get: async () => BLOCK },
    handoffs: { handoffCaptureBlock: async () => { throw Object.assign(new Error("handoff request conflicts"), { statusCode: 409 }); } },
  });
  response = {};
  await handlers.routeSwitchboardHandoffs(
    { method: "POST" }, response, new URL(`/v1/capture-blocks/${ID}/handoff`, "https://gateway.test"),
  );
  assert.equal(response.status, 409);

  response = {};
  await handlers.routeSwitchboardHandoffs(
    { method: "POST" }, response, new URL("/v1/capture-blocks/cap_bad/handoff", "https://gateway.test"),
  );
  assert.equal(response.status, 400);
});

test("handler dependency, method, and unexpected failures stay bounded", async () => {
  assert.throws(() => createSwitchboardHandoffHandlers(), /require auth/);
  const sendJson = (response, status, payload) => Object.assign(response, { status, payload });
  let handlers = createSwitchboardHandoffHandlers({
    authorized: () => true, sendJson, readJsonBody: async () => ({}),
    captureBlocks: { get: async () => BLOCK }, handoffs: {},
  });
  let response = { setHeader(name, value) { this[name] = value; } };
  await handlers.routeSwitchboardHandoffs(
    { method: "GET" }, response, new URL(`/v1/capture-blocks/${ID}/handoff`, "https://gateway.test"),
  );
  assert.equal(response.status, 405);
  assert.equal(response["cache-control"], "no-store");

  handlers = createSwitchboardHandoffHandlers({
    authorized: () => true, sendJson, readJsonBody: async () => { throw new Error("unexpected"); },
    captureBlocks: { get: async () => BLOCK }, handoffs: {},
  });
  response = {};
  await handlers.routeSwitchboardHandoffs(
    { method: "POST" }, response, new URL(`/v1/capture-blocks/${ID}/handoff`, "https://gateway.test"),
  );
  assert.equal(response.status, 500);
});
