"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { WebSocket } = require("ws");
const { createVoiceProvider } = require("../lib/voice-providers");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };
const REPLY = "First sentence. Second sentence.";

test("a second-chunk TTS failure is explicit and the unheard suffix can be retried idempotently", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-partial-tts-"));
  let synthesisCall = 0;
  const provider = createVoiceProvider({
    env: {
      MOA_MODE: "local",
      VOICE_PROVIDER: "chirp",
      VOICE_REASONING_PROVIDER: "gateway",
      VOICE_TTS_PROVIDER: "cloud-tts",
      VOICE_STREAMING: "1",
      VOICE_TTS_CONCURRENCY: "1",
      CHIRP_MODEL: "chirp_3",
      GCP_PROJECT_ID: "test-project",
      CHIRP_ACCESS_TOKEN: "test-token",
    },
    reasoner: async (input) => {
      input.on_speak_delta(REPLY);
      return {
        speak: REPLY,
        display: REPLY,
        language: "en-US",
        classification: "chat",
      };
    },
  });
  provider.synthesizeSpeech = async (text) => {
    synthesisCall += 1;
    if (synthesisCall === 2) {
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error("deterministic second chunk failure");
    }
    return Buffer.alloc(Math.max(320, text.length * 20), 1);
  };

  const voiceServer = createVoiceSessionServer({ dataDir: tempDir, voiceProvider: provider });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => voiceServer.handleUpgrade(request, socket, head));

  try {
    const port = await listen(server);
    const client = await connect(`ws://127.0.0.1:${port}${voiceServer.endpoint}`);
    client.ws.send(JSON.stringify({
      type: "session_start",
      session_id: "partial_session",
      conversation_id: "partial_session",
      branch_id: "default",
      turn_id: "partial_turn",
      source: "partial-tts-test",
      format: FORMAT,
    }));
    await client.waitFor("session_ready");
    client.ws.send(JSON.stringify({ type: "text_turn", turn_id: "partial_turn", text: "please answer" }));
    const done = await client.waitFor("turn_done");

    assert.equal(done.status, "completed");
    assert.equal(done.tts_delivery, "partial");
    assert.equal(done.tts_complete, false);
    assert.equal(done.tts_spoke, true);
    assert.equal(done.tts_segments, 1);
    assert.equal(done.tts_failed_segment_index, 1);
    assert.equal(done.tts_spoken_text_end, "First sentence.".length);
    assert.equal(done.tts_reply_text_chars, REPLY.length);
    assert.match(done.tts_error, /deterministic second chunk failure/);

    const audioDone = client.events.find((event) => event.type === "assistant_audio_done");
    assert.equal(audioDone.complete, false);
    assert.equal(audioDone.tts_delivery, "partial");

    const retry = {
      type: "retry_tts",
      turn_id: "partial_turn",
      retry_id: "retry_one",
      from_text_char: done.tts_spoken_text_end,
    };
    client.ws.send(JSON.stringify(retry));
    const retryDone = await client.waitFor("tts_retry_done");
    assert.equal(retryDone.status, "completed");
    assert.equal(retryDone.from_text_char, "First sentence. ".length);
    assert.equal(retryDone.tts_delivery, "complete");
    assert.equal(synthesisCall, 3);

    client.ws.send(JSON.stringify(retry));
    const duplicate = await client.waitFor("tts_retry_done", 2);
    assert.deepEqual(duplicate, retryDone);
    assert.equal(synthesisCall, 3, "duplicate retry_id must not synthesize or replay audio twice");
    client.ws.close();
  } finally {
    await new Promise((resolve) => voiceServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function connect(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    const events = [];
    const waiters = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      events.push(event);
      for (const waiter of waiters.slice()) {
        if (waiter.type === event.type
            && events.filter((candidate) => candidate.type === waiter.type).length >= waiter.occurrence) {
          clearTimeout(waiter.timeout);
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    });
    ws.once("error", reject);
    ws.once("open", () => {
      resolve({
        ws,
        events,
        waitFor(type, occurrence = 1) {
          const existing = events.filter((event) => event.type === type);
          if (existing.length >= occurrence) return Promise.resolve(existing[occurrence - 1]);
          return new Promise((resolveEvent, rejectEvent) => {
            const waiter = { type, occurrence, resolve: resolveEvent };
            waiter.timeout = setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              rejectEvent(new Error(`timed out waiting for ${type} #${occurrence}`));
            }, 5000);
            waiters.push(waiter);
          });
        },
      });
    });
  });
}
