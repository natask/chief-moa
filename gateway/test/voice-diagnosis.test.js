"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SESSION_ID = "voice_diag_test_session";
const PROVIDER_IDS = {
  native_live: "diag-live",
  stt: "chirp",
  reasoning: "gateway",
  tts: "cloud-tts",
};

test("voiceDiagnosisPayload attributes reasoning, tts, storage, and unknown cases conservatively", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-diagnosis-test-"));
  const dataDir = path.join(tempDir, "data");
  const serverPath = path.resolve(__dirname, "..", "server.js");
  const previousDataDir = process.env.DATA_DIR;

  try {
    seedFixtures(dataDir);
    process.env.DATA_DIR = dataDir;
    delete require.cache[serverPath];
    const { voiceDiagnosisPayload } = require(serverPath);

    const bounded = voiceDiagnosisPayload({ sessionId: SESSION_ID, limit: 99 });
    assert.equal(bounded.limit, 20);
    assert.equal(bounded.diagnoses.length, 4);

    const reasoning = voiceDiagnosisPayload({ sessionId: SESSION_ID, turnId: "reasoning_fault" }).diagnoses[0];
    assert.equal(reasoning.primary_fault?.category, "reasoning");
    assert.equal(reasoning.attributions.capture.status, "ok");
    assert.equal(reasoning.attributions.transport.status, "ok");
    assert.equal(reasoning.attributions.context.status, "ok");
    assert.equal(reasoning.attributions.reasoning.status, "fault");
    const redacted = JSON.stringify(reasoning.diagnosis_events);
    assert.ok(/\[redacted\]/.test(redacted), `secret-like fields must redact: ${redacted}`);
    assert.ok(!/Bearer raw-secret/.test(redacted));
    assert.ok(!/sk-live-secret/.test(redacted));
    assert.ok(!/AIzaFakeSecret/.test(redacted));
    assert.ok(reasoning.diagnosis_events.every((event) => !("text" in event) && !("assistant_text" in event)));

    const tts = voiceDiagnosisPayload({ sessionId: SESSION_ID, turnId: "tts_fault" }).diagnoses[0];
    assert.equal(tts.primary_fault?.category, "tts");
    assert.equal(tts.attributions.tts.status, "fault");
    assert.equal(tts.attributions.playback.status, "emitted");

    const storage = voiceDiagnosisPayload({ sessionId: SESSION_ID, turnId: "storage_fault" }).diagnoses[0];
    assert.equal(storage.primary_fault?.category, "storage");
    assert.equal(storage.attributions.storage.status, "fault");
    assert.match(storage.attributions.storage.summary, /assistant audio archive missing/);

    const unknown = voiceDiagnosisPayload({ sessionId: SESSION_ID, turnId: "anti_gaming" }).diagnoses[0];
    assert.equal(unknown.primary_fault, null);
    assert.equal(unknown.attributions.reasoning.status, "unknown");
    assert.equal(unknown.attributions.transport.status, "unknown");
    assert.equal(unknown.attributions.context.status, "unknown");
    assert.equal(unknown.attributions.playback.status, "unknown");

    const noSpeech = voiceDiagnosisPayload({ sessionId: SESSION_ID, turnId: "metadata_no_speech" }).diagnoses[0];
    assert.equal(noSpeech.status, "no_speech");
    assert.equal(noSpeech.attributions.capture.status, "fault");

    const contextFailure = voiceDiagnosisPayload({ sessionId: SESSION_ID, turnId: "metadata_context_failure" }).diagnoses[0];
    assert.equal(contextFailure.status, "error");
    assert.equal(contextFailure.attributions.context.status, "fault");

    const unfiltered = voiceDiagnosisPayload({ limit: 20 });
    assert.match(unfiltered.error, /session_id is required/);
    assert.deepEqual(unfiltered.diagnoses, []);
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    delete require.cache[serverPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function seedFixtures(dataDir) {
  writeFixture(dataDir, fixtureReasoningFault());
  writeFixture(dataDir, fixtureTtsFault());
  writeFixture(dataDir, fixtureStorageFault());
  writeFixture(dataDir, fixtureAntiGaming());
  writeMetadataOnlyFixture(dataDir, {
    ...fixtureAntiGaming(),
    turnId: "metadata_no_speech",
    status: "no_speech",
    providerEvents: [event("metadata_no_speech", "turn_no_speech", { status: "no_speech" })],
  });
  writeMetadataOnlyFixture(dataDir, {
    ...fixtureAntiGaming(),
    turnId: "metadata_context_failure",
    status: "error",
    context: { enabled: true, build_failed: true, chars: 0 },
    providerEvents: [event("metadata_context_failure", "context_attached", { enabled: true, build_failed: true, chars: 0 })],
  });
}

function writeMetadataOnlyFixture(dataDir, fixture) {
  const voiceSessionsDir = path.join(dataDir, "voice-sessions", SESSION_ID);
  fs.mkdirSync(voiceSessionsDir, { recursive: true });
  fs.writeFileSync(path.join(voiceSessionsDir, `${fixture.turnId}.json`), JSON.stringify(metadataRecord(fixture), null, 2));
}

function fixtureReasoningFault() {
  const turnId = "reasoning_fault";
  return {
    turnId,
    createdAt: "2026-07-10T19:01:00.000Z",
    transcript: "why did the model stall",
    assistantText: "",
    status: "error",
    incomplete: true,
    audioBytes: 640,
    assistantBytes: 0,
    stageTimings: { stt_ms: 12, reasoning_ms: 44, completion_ms: 50 },
    context: { enabled: true, chars: 42, all_branches_context: true },
    capture: { input_kind: "audio", audio_bytes: 640, audio_chunks: 1 },
    transport: { transport: "websocket_process_turn", input_kind: "audio", committed: true },
    providerEvents: [
      event(turnId, "context_attached", { enabled: true, chars: 42, all_branches_context: true }),
      event(turnId, "capture_committed", { input_kind: "audio", audio_bytes: 640, audio_chunks: 1 }),
      event(turnId, "transport_committed", { transport: "websocket_process_turn", input_kind: "audio", committed: true }),
      event(turnId, "stage_done", { stage: "stt", duration_ms: 12, transcript_chars: 18 }),
      event(turnId, "stage_error", {
        stage: "reasoning",
        duration_ms: 44,
        error_summary: "Bearer raw-secret sk-live-secret AIzaFakeSecret reasoning exploded",
      }),
    ],
    error: "reasoning failed while planning",
    createUserAudio: true,
    createAssistantAudio: false,
  };
}

function fixtureTtsFault() {
  const turnId = "tts_fault";
  return {
    turnId,
    createdAt: "2026-07-10T19:02:00.000Z",
    transcript: "read this aloud",
    assistantText: "Here is the reply.",
    status: "completed",
    incomplete: false,
    audioBytes: 640,
    assistantBytes: 160,
    stageTimings: { stt_ms: 8, reasoning_ms: 14, first_audio_ms: 31, tts_ms: 70, completion_ms: 72 },
    context: { enabled: true, chars: 12, all_branches_context: false },
    capture: { input_kind: "audio", audio_bytes: 640, audio_chunks: 1 },
    transport: { transport: "websocket_process_turn", input_kind: "audio", committed: true },
    providerEvents: [
      event(turnId, "context_attached", { enabled: true, chars: 12, all_branches_context: false }),
      event(turnId, "capture_committed", { input_kind: "audio", audio_bytes: 640, audio_chunks: 1 }),
      event(turnId, "transport_committed", { transport: "websocket_process_turn", input_kind: "audio", committed: true }),
      event(turnId, "stage_done", { stage: "stt", duration_ms: 8, transcript_chars: 11 }),
      event(turnId, "stage_done", { stage: "reasoning", duration_ms: 14, speak_chars: 16 }),
      event(turnId, "stage_done", { stage: "first_audio", duration_ms: 31, audio_bytes: 160 }),
      event(turnId, "stage_error", { stage: "tts", duration_ms: 70, error_summary: "hosted TTS upstream closed early" }),
    ],
    ttsError: "hosted TTS upstream closed early",
    ttsSpoke: true,
    modality: "speech",
    createUserAudio: true,
    createAssistantAudio: true,
  };
}

function fixtureStorageFault() {
  const turnId = "storage_fault";
  return {
    turnId,
    createdAt: "2026-07-10T19:03:00.000Z",
    transcript: "store this",
    assistantText: "Stored.",
    status: "completed",
    incomplete: false,
    audioBytes: 640,
    assistantBytes: 320,
    stageTimings: { stt_ms: 7, reasoning_ms: 11, tts_ms: 23, completion_ms: 25 },
    context: { enabled: true, chars: 9, all_branches_context: false },
    capture: { input_kind: "audio", audio_bytes: 640, audio_chunks: 1 },
    transport: { transport: "websocket_process_turn", input_kind: "audio", committed: true },
    providerEvents: [
      event(turnId, "context_attached", { enabled: true, chars: 9, all_branches_context: false }),
      event(turnId, "capture_committed", { input_kind: "audio", audio_bytes: 640, audio_chunks: 1 }),
      event(turnId, "transport_committed", { transport: "websocket_process_turn", input_kind: "audio", committed: true }),
      event(turnId, "stage_done", { stage: "stt", duration_ms: 7, transcript_chars: 9 }),
      event(turnId, "stage_done", { stage: "reasoning", duration_ms: 11, speak_chars: 6 }),
      event(turnId, "stage_done", { stage: "tts", duration_ms: 23, audio_bytes: 320, segments: 1, spoke: true }),
    ],
    ttsSpoke: true,
    modality: "speech",
    createUserAudio: true,
    createAssistantAudio: false,
  };
}

function fixtureAntiGaming() {
  const turnId = "anti_gaming";
  return {
    turnId,
    createdAt: "2026-07-10T19:04:00.000Z",
    transcript: "partial turn",
    assistantText: "",
    status: "interrupted",
    incomplete: true,
    audioBytes: 0,
    assistantBytes: 0,
    stageTimings: {},
    context: {},
    capture: {},
    transport: {},
    providerEvents: [event(turnId, "turn_closed", { status: "interrupted" })],
    createUserAudio: false,
    createAssistantAudio: false,
  };
}

function writeFixture(dataDir, fixture) {
  const voiceTurnsDir = path.join(dataDir, "voice-turns", SESSION_ID);
  const voiceSessionsDir = path.join(dataDir, "voice-sessions", SESSION_ID);
  fs.mkdirSync(voiceTurnsDir, { recursive: true });
  fs.mkdirSync(voiceSessionsDir, { recursive: true });

  fs.writeFileSync(path.join(voiceTurnsDir, `${fixture.turnId}.json`), JSON.stringify(canonicalRecord(fixture), null, 2));
  fs.writeFileSync(path.join(voiceSessionsDir, `${fixture.turnId}.json`), JSON.stringify(metadataRecord(fixture), null, 2));
  if (fixture.createUserAudio) {
    fs.writeFileSync(path.join(voiceSessionsDir, `${fixture.turnId}.pcm`), Buffer.alloc(fixture.audioBytes, 7));
  }
  if (fixture.createAssistantAudio) {
    fs.writeFileSync(path.join(voiceSessionsDir, `${fixture.turnId}.assistant.pcm`), Buffer.alloc(fixture.assistantBytes, 3));
  }
}

function canonicalRecord(fixture) {
  return {
    id: fixture.turnId,
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    branch_id: "default",
    profile_version: "profile_v0001",
    device_id: "diagnosis_device",
    source: "voice-diagnosis-test",
    transcript: fixture.transcript,
    transcript_source: "stt",
    classification: "chat",
    screen: null,
    created_at: fixture.createdAt,
    updated_at: fixture.createdAt,
    response: {
      turn_id: fixture.turnId,
      session_id: SESSION_ID,
      conversation_id: SESSION_ID,
      branch_id: "default",
      profile_version: "profile_v0001",
      classification: "chat",
      action: "chat",
      transcript: fixture.transcript,
      transcript_source: "stt",
      speak: fixture.assistantText,
      display: fixture.assistantText,
      text: fixture.assistantText,
      actions: [],
      agent_run: null,
      agent_runs: [],
      follow_up_expected: false,
      end_of_turn: true,
    },
    references: {
      voice_session: {
        provider: "chirp-cascaded",
        model: "voice-diagnosis-test-model",
        input_languages: ["en-US"],
        reply_language: "en-US",
        tts_spoke: fixture.ttsSpoke === true,
        modality: fixture.modality || "speech",
        tts_error: fixture.ttsError || "",
        stage_timings: fixture.stageTimings || {},
        transcript_language_rejected: false,
        audio: {
          pcm_file: `${fixture.turnId}.pcm`,
          bytes: fixture.audioBytes,
          chunks: fixture.audioBytes > 0 ? 1 : 0,
        },
        assistant_audio: {
          pcm_file: `${fixture.turnId}.assistant.pcm`,
          bytes: fixture.assistantBytes,
          chunks: fixture.assistantBytes > 0 ? 1 : 0,
        },
        context: fixture.context || {},
        capture: fixture.capture || {},
        transport: fixture.transport || {},
        playback_policy: { assistant_overlap: false },
        provider_events: fixture.providerEvents,
        transcription_only: false,
        incomplete: fixture.incomplete === true,
        status: fixture.status,
        error: fixture.error || "",
      },
    },
  };
}

function metadataRecord(fixture) {
  return {
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    branch_id: "default",
    turn_id: fixture.turnId,
    profile_version: "profile_v0001",
    provider: "chirp-cascaded",
    provider_ids: PROVIDER_IDS,
    source: "voice-diagnosis-test",
    input_format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    playback_policy: { assistant_overlap: false },
    context: fixture.context || {},
    capture: fixture.capture || {},
    transport: fixture.transport || {},
    status: fixture.status,
    started_at: fixture.createdAt,
    updated_at: fixture.createdAt,
    audio: {
      pcm_file: `${fixture.turnId}.pcm`,
      bytes: fixture.audioBytes,
      chunks: fixture.audioBytes > 0 ? 1 : 0,
    },
    assistant_audio: {
      pcm_file: `${fixture.turnId}.assistant.pcm`,
      bytes: fixture.assistantBytes,
      chunks: fixture.assistantBytes > 0 ? 1 : 0,
    },
    provider_events: fixture.providerEvents,
    stage_timings: fixture.stageTimings || {},
  };
}

function event(turnId, type, extra = {}) {
  return {
    id: `voice_evt_${turnId}_${type}`,
    ts: "2026-07-10T19:00:00.000Z",
    type,
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    branch_id: "default",
    turn_id: turnId,
    profile_version: "profile_v0001",
    device_id: "diagnosis_device",
    provider: "chirp-cascaded",
    provider_ids: PROVIDER_IDS,
    ...extra,
  };
}
