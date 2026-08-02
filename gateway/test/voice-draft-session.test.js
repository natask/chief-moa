"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WebSocket } = require("ws");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };

test("voice draft controls stay pre-execution and SEND accepts ordered PCM exactly once", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-draft-session-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const observed = { providerCalls: 0, canonicalCalls: 0, pcm: null };

  let service = await startServer(dataDir, observed);
  let client = await connect(service.url);
  client.send(startEvent("draft_turn_a", {
    version: "voice_drafts_v1", operation: "create", idempotency_key: "create-a",
  }));
  let ready = await client.next("session_ready");
  assert.equal(ready.capabilities.voice_drafts_v1.supported, true);
  assert.equal(service.voice.status().voice_drafts_v1.supported, true);
  const draftId = ready.voice_draft.draft_id;
  let revision = ready.voice_draft.revision;

  client.audio(Buffer.from([1, 0, 2, 0]));
  client.send(control(ready, draftId, revision, "pause", "pause-a"));
  let state = await client.next("voice_draft_state");
  assert.equal(state.voice_draft.state, "paused");
  revision = state.voice_draft.revision;
  assertPreExecution(observed, dataDir, "draft_session");

  client.send(control(ready, draftId, revision, "resume", "resume-a"));
  state = await client.next("voice_draft_state");
  assert.equal(state.voice_draft.state, "capturing");
  revision = state.voice_draft.revision;
  client.audio(Buffer.from([3, 0, 4, 0]));
  client.send(control(ready, draftId, revision, "park", "park-a"));
  state = await client.next("voice_draft_state");
  assert.equal(state.voice_draft.state, "parked");
  assertPreExecution(observed, dataDir, "draft_session");
  await client.close();
  await service.close();

  service = await startServer(dataDir, observed);
  client = await connect(service.url);
  client.send(startEvent("draft_turn_a", {
    version: "voice_drafts_v1",
    operation: "resume",
    draft_id: draftId,
    idempotency_key: "resume-after-restart-a",
    expected_revision: state.voice_draft.revision,
  }));
  ready = await client.next("session_ready");
  assert.equal(ready.voice_draft.state, "capturing");
  revision = ready.voice_draft.revision;
  client.audio(Buffer.from([5, 0, 6, 0]));
  client.send({
    type: "commit_turn",
    session_id: ready.session_id,
    branch_id: ready.branch_id,
    turn_id: ready.turn_id,
    draft_id: draftId,
    expected_revision: revision,
    idempotency_key: "send-a",
  });
  const sent = await client.next("voice_draft_state", (event) => event.voice_draft.state === "sent");
  assert.equal(sent.voice_draft.draft_id, draftId);
  await client.next("turn_done");
  assert.equal(observed.providerCalls, 1);
  assert.equal(observed.canonicalCalls, 1);
  assert.deepEqual(observed.pcm, Buffer.from([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]));
  client.send({ type: "commit_turn", turn_id: ready.turn_id });
  await client.next("error");
  assert.equal(observed.providerCalls, 1);
  await client.close();
  await service.close();
});

test("discarded WebSocket draft never reaches canonical intent", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-draft-discard-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const observed = { providerCalls: 0, canonicalCalls: 0, pcm: null };
  const service = await startServer(dataDir, observed);
  const client = await connect(service.url);
  client.send(startEvent("discard_turn", {
    version: "voice_drafts_v1", operation: "create", idempotency_key: "create-discard",
  }));
  const ready = await client.next("session_ready");
  client.audio(Buffer.from([9, 0, 8, 0]));
  client.send(control(
    ready, ready.voice_draft.draft_id, ready.voice_draft.revision, "discard", "discard-a",
  ));
  const discarded = await client.next("voice_draft_state");
  assert.equal(discarded.voice_draft.state, "discarded");
  assertPreExecution(observed, dataDir, "discard_session");
  const draftDir = path.join(dataDir, "voice-drafts", ready.voice_draft.draft_id);
  assert.equal(fs.existsSync(path.join(draftDir, "audio.pcm")), false);
  await client.close();
  await service.close();
});

function startEvent(turnId, voiceDraft) {
  return {
    type: "session_start",
    session_id: turnId === "discard_turn" ? "discard_session" : "draft_session",
    branch_id: "default",
    turn_id: turnId,
    device_id: "test-device",
    source: "test",
    format: FORMAT,
    voice_draft: voiceDraft,
  };
}

function control(ready, draftId, revision, action, key) {
  return {
    type: "voice_draft_control",
    session_id: ready.session_id,
    branch_id: ready.branch_id,
    turn_id: ready.turn_id,
    draft_id: draftId,
    expected_revision: revision,
    action,
    idempotency_key: key,
  };
}

function assertPreExecution(observed, dataDir, sessionId) {
  assert.equal(observed.providerCalls, 0);
  assert.equal(observed.canonicalCalls, 0);
  assert.equal(fs.existsSync(path.join(dataDir, "voice-sessions", sessionId)), false);
  assert.equal(fs.existsSync(path.join(dataDir, "voice-provider-events.jsonl")), false);
}

async function startServer(dataDir, observed) {
  const provider = {
    status: () => ({ provider: "draft-test", model: "draft-test", assistant_audio_format: FORMAT }),
    async processTurn(turn) {
      observed.providerCalls += 1;
      observed.pcm = fs.readFileSync(turn.pcmPath);
      return {
        provider: "draft-test",
        model: "draft-test",
        transcript: "ordered draft audio",
        transcript_source: "stt",
        assistant_text: "accepted",
        transcription_only: true,
      };
    },
  };
  const voice = createVoiceSessionServer({
    dataDir,
    voiceProvider: provider,
    onTurnCompleted: async (record) => {
      observed.canonicalCalls += 1;
      return { id: `canonical-${record.turn_id}` };
    },
    heartbeatIntervalMs: 0,
  });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => voice.handleUpgrade(request, socket, head));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    voice,
    url: `ws://127.0.0.1:${address.port}${voice.endpoint}`,
    async close() {
      await new Promise((resolve) => voice.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const events = [];
  const waiters = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const event = JSON.parse(Buffer.from(data).toString("utf8"));
    const index = waiters.findIndex((waiter) => waiter.type === event.type && waiter.predicate(event));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(event);
    else events.push(event);
  });
  return {
    send: (event) => ws.send(JSON.stringify(event)),
    audio: (bytes) => ws.send(bytes),
    next(type, predicate = () => true) {
      const index = events.findIndex((event) => event.type === type && predicate(event));
      if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 5000);
        waiters.push({ type, predicate, resolve: (event) => { clearTimeout(timeout); resolve(event); } });
      });
    },
    close() {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise((resolve) => { ws.once("close", resolve); ws.close(); });
    },
  };
}
