"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_RECORDS,
  buildVoiceReliabilityTimeline,
  endpointPlaybackAttribution,
  normalizeVoiceEvidenceRecord,
  recordsFromVoiceDiagnosis,
} = require("../lib/voice-reliability-timeline");

const SESSION_ID = "session:voice-1";
const TURN_ID = "turn:voice-1";
const AUTHORITY = Object.freeze({ tenant_id: "tenant:local", release_id: "release:preview-7" });

test("normalizes a bounded client receipt without allowing endpoint authority", () => {
  const record = normalizeVoiceEvidenceRecord(endpointReceipt(), { origin: "endpoint", authority: AUTHORITY });
  assert.deepEqual(record, {
    schema_version: 1,
    event_id: "client:receipt-1",
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    type: "endpoint_audio_receipt",
    source: "client_observed",
    observed_at_ms: 1_000,
    monotonic_ms: 100,
    clock_id: "clock:browser-1",
    observer_id: "observer:browser-1",
    surface: "browser_extension",
    bytes: 320,
    tenant_id: AUTHORITY.tenant_id,
    release_id: AUTHORITY.release_id,
  });
  assert.equal(Object.isFrozen(record), true);
  assert.throws(
    () => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), tenant_id: AUTHORITY.tenant_id }, { origin: "endpoint", authority: AUTHORITY }),
    /cannot assert server-owned authority/,
  );
  assert.throws(
    () => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), release_id: AUTHORITY.release_id }, { origin: "endpoint", authority: AUTHORITY }),
    /cannot assert server-owned authority/,
  );
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      endpoint_records: [endpointReceipt()],
      authority: AUTHORITY,
    }),
    /unsupported key: authority/,
  );
});

test("rejects aliases, coercion, fractional numbers, and malformed opaque IDs", () => {
  assert.throws(() => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), sessionId: SESSION_ID }), /unsupported key/);
  assert.throws(() => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), bytes: "320" }), /safe integer/);
  assert.throws(() => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), bytes: 1.5 }), /safe integer/);
  assert.throws(() => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), observed_at_ms: "1000" }), /safe integer/);
  assert.throws(() => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), turn_id: ` ${TURN_ID}` }), /canonical opaque/);
  assert.throws(() => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), event_id: "sk-abcdefghijklmnop" }), /credential-like|canonical opaque/);
  assert.throws(() => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), schema_version: "1" }), /schema_version/);
});

test("rejects raw content, credentials, nested payloads, accessors, and exotic objects", () => {
  for (const addition of [
    { raw_audio: "AAAA" },
    { transcript: "private speech" },
    { prompt: "hidden prompt" },
    { content: "model output" },
    { authorization: "Bearer secret" },
    { tool_arguments: { action: "run" } },
    { metadata: { refresh_token: "secret" } },
  ]) {
    assert.throws(() => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), ...addition }), /forbidden content or credential key/);
  }

  let getterCalled = false;
  const accessorRecord = endpointReceipt();
  Object.defineProperty(accessorRecord, "raw_audio", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "do-not-read";
    },
  });
  assert.throws(() => normalizeVoiceEvidenceRecord(accessorRecord), /data property/);
  assert.equal(getterCalled, false);

  const exotic = Object.create({ inherited: true });
  Object.assign(exotic, endpointReceipt());
  assert.throws(() => normalizeVoiceEvidenceRecord(exotic), /plain object/);
});

test("rejects credential keys, credential values, and credential-shaped opaque IDs everywhere", () => {
  for (const addition of [
    { authorization: "Bearer should-not-be-accepted" },
    { nested: { apiKey: "ordinary-looking-value" } },
    { nested: { refresh_token: "ordinary-looking-value" } },
    { nested: { clientSecret: "ordinary-looking-value" } },
    { nested: { "client.secret": "ordinary-looking-value" } },
    { nested: { "access-token": "ordinary-looking-value" } },
    { status: "https://example.test/?access_token=abcdef123456" },
    { status: "xoxc-123456789012-abcdefghijklmnop" },
    { status: "SG.abcdefghijklmnop.qrstuvwxyz0123456789" },
    { status: "password_abcdefghijklmnop" },
    { status: "secret_abcdefghijklmnop" },
    { status: "session_token_abcdefghijklmnop" },
    { status: "id_token_abcdefghijklmnop" },
    { status: "whsec_abcdefghijklmnop" },
    { status: "-----BEGIN PRIVATE KEY-----" },
  ]) {
    assert.throws(
      () => recordsFromVoiceDiagnosis({ ...emittedDiagnosis(), ...addition }),
      /forbidden content or credential key|credential-like value/,
    );
  }

  const credentialIds = {
    event_id: "ghp_abcdefghijklmnopqrstuvwxyz123456",
    session_id: "glpat-abcdefghijklmnopqrstuv",
    turn_id: "AKIAABCDEFGHIJKLMNOP",
    observer_id: "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    clock_id: "npm_abcdefghijklmnopqrstuvwxyz123456",
  };
  for (const [field, value] of Object.entries(credentialIds)) {
    assert.throws(
      () => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), [field]: value }),
      /credential-like|canonical opaque/,
    );
  }
  for (const value of [
    "api_key_abcdefghijklmnop",
    "access_token_abcdefghijklmnop",
    "refresh_token_abcdefghijklmnop",
    "client_secret_abcdefghijklmnop",
    "bearer_abcdefghijklmnop",
    "xoxc-123456789012-abcdefghijklmnop",
    "xoxd-123456789012-abcdefghijklmnop",
    "SG.abcdefghijklmnop.qrstuvwxyz0123456789",
    "password_abcdefghijklmnop",
    "secret_abcdefghijklmnop",
    "session_token_abcdefghijklmnop",
    "id_token_abcdefghijklmnop",
    "whsec_abcdefghijklmnop",
    "sk_live_abcdefghijklmnop",
    "eyJabcdefghijkl.abcdefgh.ijklmnop",
    "AIzaabcdefghijklmnop",
  ]) {
    assert.throws(
      () => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), event_id: value }),
      /credential-like|canonical opaque/,
    );
  }
  const credentialAuthority = { tenant_id: credentialIds.event_id };
  assert.throws(
    () => normalizeVoiceEvidenceRecord(endpointReceipt(), { authority: credentialAuthority }),
    /credential-like/,
  );
  assert.throws(
    () => recordsFromVoiceDiagnosis(emittedDiagnosis(), { authority: credentialAuthority }),
    /credential-like/,
  );
  assert.throws(
    () => buildVoiceReliabilityTimeline({ diagnosis: emittedDiagnosis() }, { authority: credentialAuthority }),
    /credential-like/,
  );
  const timeline = buildVoiceReliabilityTimeline({ diagnosis: emittedDiagnosis() });
  assert.throws(
    () => endpointPlaybackAttribution({ ...timeline, durations: { apiKey: "ordinary-looking-value" } }),
    /forbidden content or credential key/,
  );
  assert.doesNotThrow(() => recordsFromVoiceDiagnosis(emittedDiagnosis(), { authority: AUTHORITY }));
  assert.doesNotThrow(() => recordsFromVoiceDiagnosis({
    ...emittedDiagnosis(),
    diagnosis_events: [{
      type: "stage_error",
      error_summary: "Bearer [redacted] api_key_[redacted] password_[redacted] secret_[redacted] session_token_[redacted] id_token_[redacted] whsec_[redacted] xoxc-[redacted] SG.[redacted].[redacted]",
    }],
  }, { authority: AUTHORITY }));
});

test("rejects canonicalized raw-content paths without rejecting diagnosis audio metadata", () => {
  for (const addition of [
    { rawHeaders: { "x-trace-id": "opaque-internal-header" } },
    { "raw headers": { "x-trace-id": "opaque-internal-header" } },
    { header: "x-internal: opaque" },
    { key: "opaque-key-material" },
    { awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    { "aws-secret access key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    { audio: { assistant: { bytes: 640, archived: true, payload: "QUFBQUFB" } } },
    { audio: { assistant: { bytes: 640, archived: true, blob: "QUFBQUFB" } } },
    { audio: "QUFBQUFB" },
    { audio: { assistant: "QUFBQUFB" } },
    { audio: { assistant: { details: { samples: 1 } } } },
    { audio: { assistant: { href: "data:audio/L16;base64,QUFBQUFB" } } },
    { audio: { samples: [1, 2, 3] } },
    { tool: { arguments: { command: "exfiltrate" } } },
    { tool: { results: { output: "private" } } },
    { nested: { responseData: "private" } },
    { userTranscript: "private speech" },
    { assistantText: "private reply" },
    { systemPrompt: "hidden instruction" },
    { modelContent: "model output" },
    { completionText: "completion output" },
    { userMessage: "private message" },
    { audioSamples: [1, 2, 3] },
    { audioContent: "QUFBQUFB" },
    { audioFrames: [1, 2, 3] },
    { assistantAudioSamples: [1, 2, 3] },
    { "user-transcript": "private speech" },
    { "assistant text": "private reply" },
    { "system.prompt": "hidden instruction" },
    { model_content: "model output" },
    { "completion/text": "completion output" },
    { "user-message": "private message" },
    { "audio samples": [1, 2, 3] },
    { "audio-content": "QUFBQUFB" },
    { "audio.frames": [1, 2, 3] },
    { assistant_audio_samples: [1, 2, 3] },
  ]) {
    assert.throws(
      () => recordsFromVoiceDiagnosis({ ...emittedDiagnosis(), ...addition }),
      /forbidden content or credential key|raw or unbounded audio content|unsupported audio content container/,
    );
  }

  assert.doesNotThrow(() => recordsFromVoiceDiagnosis({
    ...emittedDiagnosis(),
    completion_ms: 25,
    content_type: "application/json; charset=utf-8",
    message_count: 1,
    transcript_chars: 12,
    first_audio_ms: 31,
    audio_bytes: 640,
    audio_chunks: 1,
    audio: {
      user: {
        kind: "user",
        encoding: "pcm16",
        content_type: "audio/L16; rate=16000; channels=1",
        bytes: 320,
        href: "/v1/voice/audio/session/turn?kind=user",
      },
      assistant: {
        kind: "assistant",
        encoding: "pcm16",
        content_type: "audio/L16; rate=16000; channels=1",
        bytes: 640,
        archived: true,
        href: "/v1/voice/audio/session/turn?kind=assistant",
      },
    },
  }));
  for (const addition of [
    { completion_ms: "private completion" },
    { content_type: "not a bounded media type" },
    { message_count: 4_097 },
    { transcript_chars: "private transcript" },
    { first_audio_ms: "private timing" },
    { audio_bytes: "private audio" },
    { audio_chunks: 4_097 },
  ]) {
    assert.throws(
      () => recordsFromVoiceDiagnosis({ ...emittedDiagnosis(), ...addition }),
      /forbidden content or credential key|raw or unbounded audio content/,
    );
  }
});

test("enforces origin, type, source, and release authority", () => {
  assert.throws(
    () => normalizeVoiceEvidenceRecord(endpointReceipt(), { origin: "provider" }),
    /origin must be endpoint or server/,
  );
  assert.throws(
    () => normalizeVoiceEvidenceRecord({ ...serverWrite(), source: "gateway_observed" }, { origin: "endpoint" }),
    /endpoint evidence/,
  );
  assert.throws(
    () => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), source: "client_observed" }, { origin: "server" }),
    /server evidence/,
  );
  assert.throws(
    () => normalizeVoiceEvidenceRecord({ ...serverWrite(), source: "provider_observed" }, { origin: "server" }),
    /requires gateway_observed/,
  );
  assert.throws(
    () => normalizeVoiceEvidenceRecord({
      ...serverBase("release", "server_authority", "server:release"),
    }, { origin: "server" }),
    /trusted release_id/,
  );
  const release = normalizeVoiceEvidenceRecord(
    serverBase("release", "server_authority", "server:release"),
    { origin: "server", authority: AUTHORITY },
  );
  assert.equal(release.release_id, AUTHORITY.release_id);
  assert.throws(
    () => normalizeVoiceEvidenceRecord({ ...serverBase("turn", "server_authority", "server:turn") }, { origin: "server" }),
    /reserved for release/,
  );
  assert.throws(
    () => normalizeVoiceEvidenceRecord({
      ...serverBase("clock_calibration", "provider_observed", "server:clock"),
      observer_id: "observer:browser-1",
      surface: "browser_extension",
      clock_id: "clock:browser-1",
      offset_ms: 10,
      uncertainty_ms: 2,
    }, { origin: "server" }),
    /gateway_observed/,
  );
  assert.throws(
    () => normalizeVoiceEvidenceRecord({
      ...serverBase("release", "gateway_observed", "server:release-wrong-source"),
    }, { origin: "server", authority: AUTHORITY }),
    /requires server_authority source/,
  );
  assert.throws(
    () => normalizeVoiceEvidenceRecord({
      ...serverBase("clock_calibration", "gateway_observed", "server:clock-missing-authority"),
      offset_ms: 10,
      uncertainty_ms: 2,
    }, { origin: "server" }),
    /requires observer_id, surface, and clock_id/,
  );
  assert.throws(
    () => normalizeVoiceEvidenceRecord({
      ...endpointBase("clock_calibration", "client:clock"),
      offset_ms: 10,
      uncertainty_ms: 2,
    }, { origin: "endpoint" }),
    /endpoint evidence/,
  );
  const noClock = endpointReceipt();
  delete noClock.clock_id;
  assert.throws(() => normalizeVoiceEvidenceRecord(noClock), /requires clock_id/);
  const noObserver = endpointReceipt();
  delete noObserver.observer_id;
  assert.throws(() => normalizeVoiceEvidenceRecord(noObserver), /requires observer_id and surface/);
});

test("accepts bounded optional endpoint buffering and measurement uncertainty", () => {
  const receipt = normalizeVoiceEvidenceRecord(endpointReceipt({ buffered_ms: 500 }));
  assert.equal(receipt.buffered_ms, 500);
  const playout = normalizeVoiceEvidenceRecord(endpointPlayout({ measurement_uncertainty_ms: 25 }));
  assert.equal(playout.measurement_uncertainty_ms, 25);
});

test("projects existing Chief Moa emitted diagnosis as metadata-only server evidence", () => {
  const records = recordsFromVoiceDiagnosis(emittedDiagnosis(), { authority: AUTHORITY });
  assert.deepEqual(records.map((record) => record.type), ["session", "turn", "server_audio_write", "release"]);
  assert.deepEqual(records.slice(0, 3).map((record) => record.source), [
    "deterministic_derived",
    "deterministic_derived",
    "deterministic_derived",
  ]);
  assert.equal(records.find((record) => record.type === "server_audio_write").bytes, 640);
  assert.ok(records.every((record) => record.session_id === SESSION_ID && record.turn_id === TURN_ID));
  assert.ok(records.every((record) => !("transcript" in record) && !("content" in record) && !("audio" in record)));

  assert.throws(
    () => recordsFromVoiceDiagnosis({ ...emittedDiagnosis(), transcript: "private speech" }),
    /forbidden content or credential key/,
  );
  assert.throws(
    () => recordsFromVoiceDiagnosis({ ...emittedDiagnosis(), updated_at: 0 }),
    /bounded timestamp/,
  );
  assert.throws(
    () => recordsFromVoiceDiagnosis({ ...emittedDiagnosis(), updated_at: "2026-07-11T10:00:01+00:00" }),
    /canonical ISO-8601 UTC/,
  );
  assert.throws(
    () => recordsFromVoiceDiagnosis({
      ...emittedDiagnosis(),
      attributions: { playback: { status: "emitted", audio_bytes: "640" } },
    }),
    /safe integer|raw or unbounded audio content/,
  );
  assert.throws(
    () => recordsFromVoiceDiagnosis({
      ...emittedDiagnosis(),
      attributions: { playback: { status: "made_up", audio_bytes: 640 } },
    }),
    /playback diagnosis status/,
  );
});

test("narrows an actual voiceDiagnosisPayload result with endpoint receipt evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-reliability-timeline-"));
  const dataDir = path.join(tempDir, "data");
  const sessionId = "timeline_integration_session";
  const turnId = "timeline_integration_turn";
  const serverPath = path.resolve(__dirname, "..", "server.js");
  const previousDataDir = process.env.DATA_DIR;
  try {
    const turnDir = path.join(dataDir, "voice-turns", sessionId);
    const sessionDir = path.join(dataDir, "voice-sessions", sessionId);
    fs.mkdirSync(turnDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    const voiceSession = {
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: "default",
      turn_id: turnId,
      status: "completed",
      started_at: "2026-07-11T10:00:00.000Z",
      updated_at: "2026-07-11T10:00:01.000Z",
      modality: "speech",
      tts_spoke: true,
      assistant_audio: { bytes: 640, chunks: 1 },
      provider_events: [{
        type: "stage_done",
        stage: "tts",
        duration_ms: 80,
        audio_bytes: 640,
        spoke: true,
      }],
    };
    fs.writeFileSync(path.join(turnDir, `${turnId}.json`), JSON.stringify({
      id: turnId,
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: "default",
      created_at: voiceSession.started_at,
      updated_at: voiceSession.updated_at,
      references: { voice_session: voiceSession },
    }));
    fs.writeFileSync(path.join(sessionDir, `${turnId}.json`), JSON.stringify(voiceSession));
    fs.writeFileSync(path.join(sessionDir, `${turnId}.assistant.pcm`), Buffer.alloc(640, 3));

    process.env.DATA_DIR = dataDir;
    delete require.cache[serverPath];
    const { voiceDiagnosisPayload } = require(serverPath);
    const diagnosis = voiceDiagnosisPayload({ sessionId, turnId }).diagnoses[0];
    assert.equal(diagnosis.attributions.playback.status, "emitted");
    const receipt = {
      ...endpointReceipt(),
      session_id: sessionId,
      turn_id: turnId,
    };
    const timeline = buildVoiceReliabilityTimeline({ diagnosis, endpoint_records: [receipt] });
    assert.equal(endpointPlaybackAttribution(timeline).status, "playback_not_observed");
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    delete require.cache[serverPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("proves endpoint evidence narrows the current server-only playback unknown", () => {
  const serverOnly = buildVoiceReliabilityTimeline({ diagnosis: emittedDiagnosis() }, { authority: AUTHORITY });
  assert.deepEqual(serverOnly.clock_relation, { status: "server_only" });
  assert.deepEqual(endpointPlaybackAttribution(serverOnly), {
    status: "endpoint_unknown",
    boundary: "transport_or_endpoint_playback",
    summary: "server-side evidence records assistant audio, but endpoint receipt and playout were not observed",
    human_heard: "unknown",
  });

  const received = buildVoiceReliabilityTimeline({
    diagnosis: emittedDiagnosis(),
    endpoint_records: [endpointReceipt()],
  }, { authority: AUTHORITY });
  assert.deepEqual(endpointPlaybackAttribution(received), {
    status: "playback_not_observed",
    boundary: "endpoint_playback",
    fault_category: "playback",
    summary: "the endpoint received audio bytes but did not observe playout",
    human_heard: "unknown",
  });

  const played = buildVoiceReliabilityTimeline({
    diagnosis: emittedDiagnosis(),
    endpoint_records: [endpointReceipt(), endpointPlayout()],
  }, { authority: AUTHORITY });
  assert.deepEqual(endpointPlaybackAttribution(played), {
    status: "endpoint_playout_observed",
    boundary: "endpoint_playback",
    summary: "the endpoint observed audio playout; human perception is not measured",
    human_heard: "unknown",
    receipt_to_playout_ms: 45,
  });
  assert.equal(Object.isFrozen(played), true);
  assert.equal(Object.isFrozen(played.records), true);
  assert.equal(Object.isFrozen(played.records[0]), true);
  assert.equal(Object.isFrozen(played.clock_relation), true);
  assert.equal(Object.isFrozen(played.durations), true);
  assert.equal(Object.isFrozen(endpointPlaybackAttribution(played)), true);
  assert.equal(Object.isFrozen(recordsFromVoiceDiagnosis(emittedDiagnosis())), true);
});

test("does not invent server audio evidence from endpoint claims", () => {
  const timeline = buildVoiceReliabilityTimeline({
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    endpoint_records: [endpointReceipt()],
  });
  assert.equal(endpointPlaybackAttribution(timeline).status, "no_server_audio_evidence");
});

test("enforces exact single-session and single-turn joins before attribution", () => {
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      diagnosis: emittedDiagnosis(),
      endpoint_records: [{ ...endpointReceipt(), session_id: "session:other" }],
    }),
    /cannot cross timeline session or turn/,
  );
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      diagnosis: emittedDiagnosis(),
      endpoint_records: [{ ...endpointReceipt(), turn_id: "turn:other" }],
    }),
    /cannot cross timeline session or turn/,
  );
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      diagnosis: emittedDiagnosis(),
      session_id: "session:other",
      turn_id: TURN_ID,
    }),
    /diagnosis authority does not match/,
  );
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      endpoint_records: [endpointReceipt(), endpointReceipt({
        event_id: "client:receipt-other",
        observer_id: "observer:browser-2",
      })],
    }),
    /different endpoint observers/,
  );
});

test("deduplicates identical IDs and rejects conflicting duplicates", () => {
  const duplicate = buildVoiceReliabilityTimeline({
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    endpoint_records: [endpointReceipt(), endpointReceipt()],
  });
  assert.equal(duplicate.records.length, 1);
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      endpoint_records: [endpointReceipt(), { ...endpointReceipt(), bytes: 321 }],
    }),
    /conflicting duplicate/,
  );
});

test("rejects ambiguous duplicate receipt and playout milestones", () => {
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      endpoint_records: [
        endpointReceipt(),
        endpointReceipt({ event_id: "client:receipt-2", monotonic_ms: 120 }),
      ],
    }),
    /at most one endpoint audio receipt milestone/,
  );
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      endpoint_records: [
        endpointReceipt(),
        endpointPlayout(),
        endpointPlayout({ event_id: "client:playout-2", monotonic_ms: 160 }),
      ],
    }),
    /at most one endpoint observed playout milestone/,
  );
  const exact = buildVoiceReliabilityTimeline({
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    endpoint_records: [endpointReceipt({ monotonic_ms: 100 }), endpointPlayout({ monotonic_ms: 200 })],
  });
  assert.deepEqual(exact.durations, { endpoint_receipt_to_playout_ms: 100 });
});

test("orders deterministically while leaving uncalibrated cross-source clocks uncertain", () => {
  const timeline = buildVoiceReliabilityTimeline({
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    server_records: [serverWrite({ observed_at_ms: 2_000, monotonic_ms: 20, clock_id: "clock:gateway-1" })],
    endpoint_records: [
      endpointPlayout({ observed_at_ms: 1_100, monotonic_ms: 145 }),
      endpointReceipt({ observed_at_ms: 1_000, monotonic_ms: 100 }),
    ],
  });
  assert.deepEqual(timeline.records.map((record) => record.event_id), [
    "client:receipt-1",
    "client:playout-1",
    "server:audio-write",
  ]);
  assert.deepEqual(timeline.clock_relation, { status: "uncertain" });
  assert.deepEqual(timeline.durations, { endpoint_receipt_to_playout_ms: 45 });
});

test("uses one transitive isotonic navigation order for every input permutation", () => {
  const receipt = endpointReceipt({ observed_at_ms: 3_000, monotonic_ms: 100 });
  const playout = endpointPlayout({ observed_at_ms: 1_000, monotonic_ms: 200 });
  const write = serverWrite({ observed_at_ms: 2_000 });
  const evidencePermutations = [
    [receipt, playout, write],
    [receipt, write, playout],
    [playout, receipt, write],
    [playout, write, receipt],
    [write, receipt, playout],
    [write, playout, receipt],
  ];
  const orders = evidencePermutations.map((records) => {
    const timeline = buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      server_records: records.filter((record) => record.source !== "client_observed"),
      endpoint_records: records.filter((record) => record.source === "client_observed"),
    });
    return JSON.stringify(timeline.records.map((record) => record.event_id));
  });
  assert.equal(new Set(orders).size, 1);
  assert.equal(orders[0], JSON.stringify(["server:audio-write", "client:receipt-1", "client:playout-1"]));
});

test("preserves an entire same-clock monotonic chain when endpoint wall time moves backward", () => {
  const receipt = endpointReceipt({ observed_at_ms: 3_000, monotonic_ms: 100 });
  const transport = endpointTransport({
    event_id: "client:transport-chain",
    observed_at_ms: 500,
    monotonic_ms: 150,
    clock_id: "clock:browser-1",
  });
  const playout = endpointPlayout({ observed_at_ms: 1_000, monotonic_ms: 200 });
  const permutations = [
    [receipt, transport, playout],
    [receipt, playout, transport],
    [transport, receipt, playout],
    [transport, playout, receipt],
    [playout, receipt, transport],
    [playout, transport, receipt],
  ];
  const orders = permutations.map((endpoint_records) => buildVoiceReliabilityTimeline({
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    endpoint_records,
  }).records.map((record) => record.event_id));
  assert.equal(new Set(orders.map((order) => JSON.stringify(order))).size, 1);
  assert.deepEqual(orders[0], ["client:receipt-1", "client:transport-chain", "client:playout-1"]);
});

test("uses canonical semantic and event ties inside one monotonic clock domain", () => {
  const sameMonotonic = { monotonic_ms: 100, clock_id: "clock:browser-1" };
  const eventOrder = buildVoiceReliabilityTimeline({
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    endpoint_records: [
      endpointTransport({ ...sameMonotonic, event_id: "client:z", observed_at_ms: 1_000 }),
      endpointTransport({ ...sameMonotonic, event_id: "client:a", observed_at_ms: 2_000 }),
    ],
  });
  assert.deepEqual(eventOrder.records.map((record) => record.event_id), ["client:a", "client:z"]);

  const typeOrder = buildVoiceReliabilityTimeline({
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    endpoint_records: [
      endpointTransport({ ...sameMonotonic, event_id: "client:transport-tie", observed_at_ms: 1_000 }),
      endpointReceipt({ ...sameMonotonic, event_id: "client:receipt-tie", observed_at_ms: 1_000 }),
    ],
  });
  assert.deepEqual(typeOrder.records.map((record) => record.event_id), ["client:receipt-tie", "client:transport-tie"]);

  const causalTie = buildVoiceReliabilityTimeline({
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    endpoint_records: [
      endpointReceipt({ ...sameMonotonic, observed_at_ms: 3_000 }),
      endpointPlayout({ ...sameMonotonic, observed_at_ms: 1_000 }),
    ],
  });
  assert.deepEqual(causalTie.records.map((record) => record.event_id), ["client:receipt-1", "client:playout-1"]);
});

test("calibration bounds clock relation but never fabricates a cross-source duration", () => {
  const calibration = {
    ...serverBase("clock_calibration", "gateway_observed", "server:clock-1"),
    observer_id: "observer:browser-1",
    surface: "browser_extension",
    clock_id: "clock:browser-1",
    offset_ms: 900,
    uncertainty_ms: 12,
  };
  const timeline = buildVoiceReliabilityTimeline({
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    server_records: [serverWrite(), calibration],
    endpoint_records: [endpointReceipt({ monotonic_ms: undefined })],
  });
  assert.deepEqual(timeline.clock_relation, { status: "calibrated", offset_ms: 900, uncertainty_ms: 12 });
  assert.deepEqual(timeline.durations, {});
});

test("multiple server calibrations widen uncertainty instead of selecting a flattering sample", () => {
  const calibrationA = {
    ...serverBase("clock_calibration", "gateway_observed", "server:clock-a"),
    observer_id: "observer:browser-1",
    surface: "browser_extension",
    clock_id: "clock:browser-1",
    offset_ms: 900,
    uncertainty_ms: 12,
  };
  const calibrationB = {
    ...calibrationA,
    event_id: "server:clock-b",
    offset_ms: 1_000,
    uncertainty_ms: 20,
  };
  const timeline = buildVoiceReliabilityTimeline({
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    server_records: [serverWrite(), calibrationA, calibrationB],
    endpoint_records: [endpointReceipt()],
  });
  assert.deepEqual(timeline.clock_relation, { status: "calibrated", offset_ms: 954, uncertainty_ms: 66 });
});

test("rejects orphan and foreign endpoint clock calibrations", () => {
  const calibration = {
    ...serverBase("clock_calibration", "gateway_observed", "server:clock-exact"),
    observer_id: "observer:browser-1",
    surface: "browser_extension",
    clock_id: "clock:browser-1",
    offset_ms: 900,
    uncertainty_ms: 12,
  };
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      server_records: [serverWrite(), calibration],
    }),
    /requires one matching endpoint observer and clock epoch/,
  );
  for (const mutation of [
    { observer_id: "observer:browser-2" },
    { surface: "android" },
    { clock_id: "clock:browser-2" },
  ]) {
    assert.throws(
      () => buildVoiceReliabilityTimeline({
        session_id: SESSION_ID,
        turn_id: TURN_ID,
        server_records: [serverWrite(), { ...calibration, ...mutation }],
        endpoint_records: [endpointReceipt()],
      }),
      /must match the timeline endpoint observer, surface, and clock epoch/,
    );
  }
  const clocklessReceipt = endpointReceipt({ monotonic_ms: undefined });
  delete clocklessReceipt.clock_id;
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      server_records: [serverWrite(), calibration],
      endpoint_records: [clocklessReceipt],
    }),
    /requires one matching endpoint observer and clock epoch/,
  );
});

test("never subtracts monotonic timestamps across endpoint clock epochs", () => {
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      server_records: [serverWrite()],
      endpoint_records: [
        endpointReceipt({ monotonic_ms: 100, clock_id: "clock:browser-1" }),
        endpointPlayout({ monotonic_ms: 145, clock_id: "clock:browser-2" }),
      ],
    }),
    /different endpoint observers or clock epochs/,
  );
});

test("allows clockless metadata from the same endpoint without inventing a duration", () => {
  const transport = {
    ...endpointBase("transport", "client:transport-1"),
    transport_state: "open",
    transport_kind: "websocket",
  };
  delete transport.clock_id;
  const timeline = buildVoiceReliabilityTimeline({
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    server_records: [serverWrite()],
    endpoint_records: [transport, endpointReceipt()],
  });
  assert.equal(timeline.records.some((record) => record.type === "transport"), true);
});

test("attribution revalidates records and recomputes derived fields", () => {
  const timeline = buildVoiceReliabilityTimeline({
    diagnosis: emittedDiagnosis(),
    endpoint_records: [endpointReceipt(), endpointPlayout()],
  }, { authority: AUTHORITY });
  const forgedDuration = { ...timeline, durations: { endpoint_receipt_to_playout_ms: 1 } };
  assert.equal(endpointPlaybackAttribution(forgedDuration).receipt_to_playout_ms, 45);

  const authorityMismatch = {
    ...timeline,
    records: timeline.records.map((record, index) => (
      index === 0 ? { ...record, tenant_id: "tenant:other" } : record
    )),
  };
  assert.throws(() => endpointPlaybackAttribution(authorityMismatch), /tenant authority does not match/);
  const releaseMismatch = {
    ...timeline,
    records: timeline.records.map((record, index) => (
      index === 0 ? { ...record, release_id: "release:other" } : record
    )),
  };
  assert.throws(() => endpointPlaybackAttribution(releaseMismatch), /release authority does not match/);
  assert.throws(
    () => endpointPlaybackAttribution({ ...timeline, schema_version: 2 }),
    /invalid voice reliability timeline/,
  );
  const coercedAuthority = {
    ...buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      endpoint_records: [endpointReceipt()],
    }),
  };
  coercedAuthority.records = coercedAuthority.records.map((record, index) => (
    index === 0 ? { ...record, tenant_id: 0 } : record
  ));
  assert.throws(() => endpointPlaybackAttribution(coercedAuthority), /canonical opaque/);

  const injected = {
    ...timeline,
    records: [...timeline.records, {
      ...endpointReceipt(),
      tenant_id: AUTHORITY.tenant_id,
      release_id: AUTHORITY.release_id,
      raw_audio: "AAAA",
    }],
  };
  assert.throws(() => endpointPlaybackAttribution(injected), /forbidden content or credential key/);
});

test("rejects impossible endpoint playout sequences", () => {
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      endpoint_records: [endpointPlayout()],
    }),
    /requires endpoint receipt/,
  );
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      endpoint_records: [endpointReceipt({ monotonic_ms: 200 }), endpointPlayout({ monotonic_ms: 100 })],
    }),
    /cannot precede its receipt/,
  );
});

test("enforces record count, configured limit, byte, and nesting budgets", () => {
  const exact = Array.from({ length: MAX_RECORDS }, (_, index) => endpointTransport({
    event_id: `client:transport-${index}`,
    observed_at_ms: index,
  }));
  assert.equal(buildVoiceReliabilityTimeline({
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    endpoint_records: exact,
  }).records.length, MAX_RECORDS);
  const maximumServerRecords = Array.from({ length: MAX_RECORDS }, (_, index) => ({
    ...serverBase("transport", "gateway_observed", `server:transport-${index}`),
    transport_state: "open",
  }));
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      server_records: maximumServerRecords,
      endpoint_records: [endpointReceipt()],
    }),
    /accepts at most 256 records/,
  );
  const many = Array.from({ length: MAX_RECORDS + 1 }, (_, index) => endpointReceipt({ event_id: `client:receipt-${index}` }));
  assert.throws(
    () => buildVoiceReliabilityTimeline({ session_id: SESSION_ID, turn_id: TURN_ID, endpoint_records: many }),
    /record limit|at most/,
  );
  assert.throws(
    () => buildVoiceReliabilityTimeline({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      endpoint_records: [endpointReceipt(), endpointReceipt({ event_id: "client:receipt-2" })],
      limit: 1,
    }),
    /configured limit/,
  );
  assert.throws(
    () => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), padding: "x".repeat(5_000) }),
    /byte limit/,
  );
  assert.throws(
    () => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), bytes: Number.MAX_SAFE_INTEGER }),
    /outside its allowed range/,
  );
  assert.throws(
    () => normalizeVoiceEvidenceRecord({ ...endpointPlayout(), played_ms: Number.MAX_SAFE_INTEGER }),
    /outside its allowed range/,
  );
  assert.throws(
    () => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), monotonic_ms: Number.MAX_SAFE_INTEGER }),
    /outside its allowed range/,
  );
  let nested = { value: true };
  for (let index = 0; index < 20; index += 1) nested = { nested };
  assert.throws(
    () => normalizeVoiceEvidenceRecord({ ...endpointReceipt(), metadata: nested }),
    /nesting limit/,
  );
});

test("enforces exact encoded diagnosis and timeline byte limits", () => {
  const diagnosisLimit = 128 * 1024;
  const exactDiagnosis = padObjectToExactJsonBytes({
    ...emittedDiagnosis(),
    safe_values: Array(4_000).fill(""),
    "field\"\\\nname": "escaped\n\"\\value",
  }, diagnosisLimit);
  assert.equal(Buffer.byteLength(JSON.stringify(exactDiagnosis), "utf8"), diagnosisLimit);
  assert.doesNotThrow(() => recordsFromVoiceDiagnosis(exactDiagnosis));
  assert.throws(
    () => recordsFromVoiceDiagnosis({ ...exactDiagnosis, padding: `${exactDiagnosis.padding}x` }),
    /byte limit/,
  );

  const timelineLimit = 512 * 1024;
  const baseTimeline = buildVoiceReliabilityTimeline({ diagnosis: emittedDiagnosis() });
  const exactTimeline = padTimelineToExactJsonBytes({
    ...baseTimeline,
    clock_relation: {
      status: "server_only",
      safe_values: Array(4_000).fill(""),
      "field\"\\\nname": "escaped\n\"\\value",
    },
  }, timelineLimit);
  assert.equal(Buffer.byteLength(JSON.stringify(exactTimeline), "utf8"), timelineLimit);
  assert.equal(endpointPlaybackAttribution(exactTimeline).status, "endpoint_unknown");
  assert.throws(
    () => endpointPlaybackAttribution({
      ...exactTimeline,
      clock_relation: {
        ...exactTimeline.clock_relation,
        padding: `${exactTimeline.clock_relation.padding}x`,
      },
    }),
    /byte limit/,
  );
});

test("rejects sparse arrays and cyclic build input without hanging", () => {
  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () => buildVoiceReliabilityTimeline({ session_id: SESSION_ID, turn_id: TURN_ID, endpoint_records: sparse }),
    /cannot contain holes/,
  );
  const cyclic = { session_id: SESSION_ID, turn_id: TURN_ID, endpoint_records: [] };
  cyclic.self = cyclic;
  assert.throws(() => buildVoiceReliabilityTimeline(cyclic), /cannot be cyclic/);
  const symbolArray = [endpointReceipt()];
  symbolArray[Symbol("hidden")] = endpointReceipt({ event_id: "client:hidden" });
  assert.throws(
    () => buildVoiceReliabilityTimeline({ session_id: SESSION_ID, turn_id: TURN_ID, endpoint_records: symbolArray }),
    /symbol keys/,
  );
});

test("rejects non-ordinary arrays without invoking inherited or own behavior", () => {
  const buildWith = (endpointRecords) => buildVoiceReliabilityTimeline({
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    endpoint_records: endpointRecords,
  });

  class EndpointArray extends Array {}
  assert.throws(() => buildWith(new EndpointArray(endpointReceipt())), /standard Array prototype/);

  let inheritedIteratorCalls = 0;
  const inheritedIterator = [endpointReceipt()];
  const iteratorPrototype = Object.create(Array.prototype);
  Object.defineProperty(iteratorPrototype, Symbol.iterator, {
    value() {
      inheritedIteratorCalls += 1;
      return [][Symbol.iterator]();
    },
  });
  Object.setPrototypeOf(inheritedIterator, iteratorPrototype);
  assert.throws(() => buildWith(inheritedIterator), /standard Array prototype/);
  assert.equal(inheritedIteratorCalls, 0);

  let inheritedGetterCalls = 0;
  const inheritedGetter = [endpointReceipt()];
  const getterPrototype = Object.create(Array.prototype);
  Object.defineProperty(getterPrototype, Symbol.iterator, {
    get() {
      inheritedGetterCalls += 1;
      return Array.prototype[Symbol.iterator];
    },
  });
  Object.setPrototypeOf(inheritedGetter, getterPrototype);
  assert.throws(() => buildWith(inheritedGetter), /standard Array prototype/);
  assert.equal(inheritedGetterCalls, 0);

  let ownIteratorCalls = 0;
  const ownIterator = [endpointReceipt()];
  Object.defineProperty(ownIterator, Symbol.iterator, {
    get() {
      ownIteratorCalls += 1;
      return Array.prototype[Symbol.iterator];
    },
  });
  assert.throws(() => buildWith(ownIterator), /symbol keys/);
  assert.equal(ownIteratorCalls, 0);

  const nonEnumerable = [endpointReceipt()];
  Object.defineProperty(nonEnumerable, "0", { enumerable: false });
  assert.throws(() => buildWith(nonEnumerable), /indexed enumerable own-data entries/);

  const named = [endpointReceipt()];
  named.extra = endpointReceipt({ event_id: "client:named" });
  assert.throws(() => buildWith(named), /indexed enumerable own-data entries/);
});

test("rejects a large dense array before bulk descriptor materialization", () => {
  const dense = Array(100_000).fill(endpointReceipt());
  const originalGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
  let denseBulkDescriptorCalls = 0;
  Object.getOwnPropertyDescriptors = function getOwnPropertyDescriptors(value) {
    if (value === dense) denseBulkDescriptorCalls += 1;
    return originalGetOwnPropertyDescriptors(value);
  };
  try {
    assert.throws(
      () => buildVoiceReliabilityTimeline({
        session_id: SESSION_ID,
        turn_id: TURN_ID,
        endpoint_records: dense,
      }),
      /array exceeds item limit/,
    );
  } finally {
    Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors;
  }
  assert.equal(denseBulkDescriptorCalls, 0);
});

test("timeline production module remains synchronous and I/O-free", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../lib/voice-reliability-timeline.js"), "utf8");
  for (const forbidden of [
    /\brequire\s*\(/,
    /\bimport\s+/,
    /process\.env/,
    /\bsetTimeout\s*\(/,
    /\bsetInterval\s*\(/,
    /\bfetch\s*\(/,
    /\bMath\.random\s*\(/,
    /\bDate\.now\s*\(/,
    /node:(?:fs|http|https|net|tls|dns|timers)/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("rejects non-object records and object symbol keys", () => {
  assert.throws(() => normalizeVoiceEvidenceRecord(null), /must be a plain object/);
  const symbolRecord = endpointReceipt();
  symbolRecord[Symbol("hidden")] = "hidden";
  assert.throws(() => normalizeVoiceEvidenceRecord(symbolRecord), /symbol keys/);
});

function emittedDiagnosis() {
  return {
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    created_at: "2026-07-11T10:00:00.000Z",
    updated_at: "2026-07-11T10:00:01.000Z",
    status: "completed",
    attributions: {
      playback: {
        status: "emitted",
        summary: "gateway emitted assistant PCM; client playback is not observed server-side",
        audio_bytes: 640,
      },
    },
    audio: { assistant: { bytes: 640, archived: true } },
    diagnosis_events: [{ type: "stage_done", stage: "tts", duration_ms: 80, audio_bytes: 640 }],
  };
}

function endpointReceipt(overrides = {}) {
  const record = {
    ...endpointBase("endpoint_audio_receipt", "client:receipt-1"),
    monotonic_ms: 100,
    bytes: 320,
    ...overrides,
  };
  if (record.monotonic_ms === undefined) delete record.monotonic_ms;
  return record;
}

function endpointPlayout(overrides = {}) {
  const record = {
    ...endpointBase("endpoint_observed_playout", "client:playout-1"),
    observed_at_ms: 1_100,
    monotonic_ms: 145,
    played_ms: 40,
    ...overrides,
  };
  if (record.monotonic_ms === undefined) delete record.monotonic_ms;
  return record;
}

function endpointTransport(overrides = {}) {
  return {
    ...endpointBase("transport", "client:transport-1"),
    transport_state: "open",
    transport_kind: "websocket",
    ...overrides,
  };
}

function endpointBase(type, eventId) {
  return {
    schema_version: 1,
    event_id: eventId,
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    type,
    source: "client_observed",
    observed_at_ms: 1_000,
    observer_id: "observer:browser-1",
    surface: "browser_extension",
    clock_id: "clock:browser-1",
  };
}

function serverWrite(overrides = {}) {
  const record = {
    ...serverBase("server_audio_write", "gateway_observed", "server:audio-write"),
    bytes: 640,
    ...overrides,
  };
  if (record.monotonic_ms === undefined) delete record.monotonic_ms;
  return record;
}

function serverBase(type, source, eventId) {
  return {
    schema_version: 1,
    event_id: eventId,
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    type,
    source,
    observed_at_ms: 900,
  };
}

function padObjectToExactJsonBytes(input, maximumBytes) {
  const output = { ...input, padding: "" };
  const baseBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  assert.ok(baseBytes <= maximumBytes, `fixture base ${baseBytes} must fit ${maximumBytes}`);
  output.padding = "x".repeat(maximumBytes - baseBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(output), "utf8"), maximumBytes);
  return output;
}

function padTimelineToExactJsonBytes(input, maximumBytes) {
  const output = {
    ...input,
    clock_relation: { ...input.clock_relation, padding: "" },
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  assert.ok(baseBytes <= maximumBytes, `fixture base ${baseBytes} must fit ${maximumBytes}`);
  output.clock_relation.padding = "x".repeat(maximumBytes - baseBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(output), "utf8"), maximumBytes);
  return output;
}
