"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { WebSocketServer } = require("ws");
const { createVoiceProvider } = require("../lib/voice-providers");

for (const fixture of [
  { id: "openai-realtime", key: "OPENAI_API_KEY", endpoint: "OPENAI_REALTIME_ENDPOINT", shape: "openai" },
  { id: "xai-voice", key: "XAI_API_KEY", endpoint: "XAI_REALTIME_ENDPOINT", shape: "xai" },
]) {
  test(`${fixture.id} preserves the live phone provider contract`, async (t) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const received = [];
    wss.on("connection", (socket) => socket.on("message", (raw) => {
      const event = JSON.parse(String(raw));
      received.push(event);
      if (event.type === "session.update") socket.send(JSON.stringify({ type: "session.updated" }));
      if (event.type === "input_audio_buffer.commit") {
        socket.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello" }));
        socket.send(JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "Hi." }));
        socket.send(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.alloc(4800, 1).toString("base64") }));
        socket.send(JSON.stringify({ type: "response.done", response: { status: "completed" } }));
      }
    }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => wss.close(() => server.close(resolve))));
    const env = {
      VOICE_PROVIDER: fixture.id,
      [fixture.key]: "fixture-key",
      [fixture.endpoint]: `ws://127.0.0.1:${server.address().port}`,
    };
    const provider = createVoiceProvider({ env, systemPrompt: "Use the configured realtime fallback prompt." });
    assert.equal(provider.status().provider, fixture.id);
    const transcripts = [];
    const text = [];
    const audio = [];
    let audioStarts = 0;
    let audioDone = 0;
    const session = provider.createLiveTurnSession({
      format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
      effectiveProfile: {
        system_prompt: fixture.shape === "openai" ? "Say exactly what I ask in voice mode." : "",
        spoken_reply_style: "calm, plain, conversational",
        input_languages: "en-US,am-ET",
        language: "am-ET",
        voice: "fixture-voice",
      },
    }, {
      onTranscriptPartial: async () => {},
      onTranscriptFinal: async (value) => transcripts.push(value),
      onAssistantText: async (value) => text.push(value),
      onAssistantAudioStart: async () => { audioStarts += 1; },
      sendAudio: async (value) => audio.push(Buffer.from(value)),
      onAssistantAudioDone: async () => { audioDone += 1; },
    });
    session.sendAudio(Buffer.alloc(3200, 2));
    session.commit();
    const result = await session.done;

    const update = received.find((event) => event.type === "session.update").session;
    assert.match(update.instructions, fixture.shape === "openai"
      ? /Say exactly what I ask/
      : /Use the configured realtime fallback prompt/);
    assert.match(update.instructions, /Spoken reply style preference:\n- calm, plain, conversational/);
    assert.match(update.instructions, /Voice mode: this reply will be heard/);
    assert.match(update.instructions, /cannot weaken the required voice rules, safety boundaries, tool policy, or approval requirements/);
    assert.match(update.instructions, /en-US,am-ET/);
    assert.match(update.instructions, /am-ET/);
    assert.deepEqual(update.tools, []);
    assert.equal(update.audio.output.voice, "fixture-voice");
    assert.equal(fixture.shape === "openai" ? update.type : update.type || null, fixture.shape === "openai" ? "realtime" : null);
    assert.ok(received.some((event) => event.type === "input_audio_buffer.append"));
    assert.deepEqual(transcripts, ["hello"]);
    assert.deepEqual(text, ["Hi."]);
    assert.equal(audioStarts, 1);
    assert.equal(audioDone, 1);
    assert.ok(Buffer.concat(audio).length > 0);
    assert.equal(result.transcript, "hello");
    assert.equal(result.assistant_text, "Hi.");
  });
}

test("native realtime completion without assistant output is retryable", async (t) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.on("message", (raw) => {
    const event = JSON.parse(String(raw));
    if (event.type === "session.update") socket.send(JSON.stringify({ type: "session.updated" }));
    if (event.type === "input_audio_buffer.commit") {
      socket.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello" }));
      socket.send(JSON.stringify({ type: "response.done", response: { status: "completed" } }));
    }
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => wss.close(() => server.close(resolve))));
  const provider = createVoiceProvider({ env: {
    VOICE_PROVIDER: "openai-realtime", OPENAI_API_KEY: "fixture-key",
    OPENAI_REALTIME_ENDPOINT: `ws://127.0.0.1:${server.address().port}`,
  } });
  const session = provider.createLiveTurnSession({
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  }, hooks());
  session.sendAudio(Buffer.alloc(3200, 2));
  session.commit();
  await assert.rejects(session.done, (error) => error?.code === "native_provider_empty_response"
    && error?.retryable === true);
});

function hooks() {
  return {
    onTranscriptPartial: async () => {}, onTranscriptFinal: async () => {},
    onAssistantText: async () => {}, onAssistantAudioStart: async () => {},
    sendAudio: async () => {}, onAssistantAudioDone: async () => {},
  };
}
