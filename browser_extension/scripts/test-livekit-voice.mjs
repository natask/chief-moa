import assert from "node:assert/strict";

const original = { chrome: globalThis.chrome, fetch: globalThis.fetch };

function chromeHarness(overrides = {}) {
  const calls = { close: 0, create: [], runtime: [], tabs: [] };
  let listener = null;
  const chrome = {
    storage: { local: { get: async () => ({ ageeLivekitVoiceEnabled: true }) } },
    runtime: {
      onMessage: { addListener(value) { listener = value; } },
      async sendMessage(message) { calls.runtime.push(message); return { ok: true }; },
    },
    offscreen: {
      async closeDocument() { calls.close += 1; },
      async createDocument(options) { calls.create.push(options); },
    },
    tabs: {
      async sendMessage(tabId, message) { calls.tabs.push({ tabId, message }); },
    },
    ...overrides,
  };
  return { chrome, calls, listener: () => listener };
}

function tokenResponse(overrides = {}) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ url: "wss://livekit.test", token: "room-token", room: "room-1" }),
    ...overrides,
  };
}

let state = chromeHarness();
globalThis.chrome = state.chrome;
globalThis.fetch = async () => tokenResponse();
let livekit = await import(`../extension/livekit-voice.js?success=${Date.now()}`);
assert.equal(await livekit.isLivekitVoiceEnabled(), true);
const session = await livekit.startLivekitVoiceSession({
  tabId: 7,
  cueId: "cue",
  gatewayUrl: "https://gateway.test/",
  gatewayToken: "gateway-token",
  sessionId: "session",
  deviceId: "device",
});
assert.equal(session.livekit, true);
assert.equal(session.room, "room-1");
assert.match(session.voiceSessionId, /^lkv_/);
assert.equal(state.calls.close, 1);
assert.deepEqual(state.calls.create[0], {
  url: "offscreen-livekit.html",
  reasons: ["USER_MEDIA", "WEB_RTC"],
  justification: "A.G. captures microphone audio and runs a WebRTC session to the configured LiveKit voice transport (experimental).",
});
assert.equal(state.calls.runtime[0].cmd, "livekitConnect");

const listener = state.listener();
assert.equal(listener(null), false);
assert.equal(listener({ cmd: "other" }), false);
assert.equal(listener({ cmd: "livekitOffscreenEvent", id: "missing", kind: "state", state: "thinking" }), false);
assert.equal(listener({ cmd: "livekitOffscreenEvent", id: session.voiceSessionId, kind: "state", state: "thinking" }), false);
assert.deepEqual(state.calls.tabs.pop(), { tabId: 7, message: { cmd: "livekitAgentState", state: "thinking" } });
listener({ cmd: "livekitOffscreenEvent", id: session.voiceSessionId, kind: "error", message: "boom" });
assert.deepEqual(state.calls.tabs.pop(), {
  tabId: 7,
  message: { cmd: "livekitNotice", cueId: "cue", text: "LiveKit voice error: boom" },
});
listener({ cmd: "livekitOffscreenEvent", id: session.voiceSessionId, kind: "error", message: "" });
assert.match(state.calls.tabs.pop().message.text, /unknown/);
listener({ cmd: "livekitOffscreenEvent", id: session.voiceSessionId, kind: "disconnected" });
assert.equal(listener({ cmd: "livekitOffscreenEvent", id: session.voiceSessionId, kind: "state", state: "speaking" }), false);

await livekit.closeLivekitVoiceSession(session.voiceSessionId);
assert.equal(state.calls.runtime.at(-1).cmd, "livekitDisconnect");
await livekit.closeLivekitVoiceSession("");
assert.equal(state.calls.runtime.at(-1).id, null);

state = chromeHarness({
  storage: { local: { get: async () => { throw new Error("storage unavailable"); } } },
  runtime: {
    onMessage: { addListener() {} },
    sendMessage: async () => { throw new Error("not loaded"); },
  },
  offscreen: { closeDocument: async () => { throw new Error("already closed"); }, createDocument: async () => {} },
});
globalThis.chrome = state.chrome;
livekit = await import(`../extension/livekit-voice.js?failsoft=${Date.now()}`);
assert.equal(await livekit.isLivekitVoiceEnabled(), false);
await livekit.closeLivekitVoiceSession("id");

async function startFailure({ fetchImpl = async () => tokenResponse(), chromeOverrides = {}, args = {}, pattern }) {
  const harness = chromeHarness(chromeOverrides);
  globalThis.chrome = harness.chrome;
  globalThis.fetch = fetchImpl;
  const module = await import(`../extension/livekit-voice.js?failure=${Math.random()}`);
  await assert.rejects(module.startLivekitVoiceSession({
    tabId: 1, cueId: "", gatewayUrl: "https://gateway.test", gatewayToken: "", sessionId: "", deviceId: "", ...args,
  }), pattern);
  return harness;
}

await startFailure({ args: { gatewayUrl: "" }, pattern: /gateway URL/ });
await startFailure({
  fetchImpl: async () => tokenResponse({ status: 503, ok: false, text: async () => JSON.stringify({ reason: "disabled" }) }),
  pattern: /disabled/,
});
await startFailure({
  fetchImpl: async () => tokenResponse({ status: 503, ok: false, text: async () => "bad" }),
  pattern: /not_configured/,
});
await startFailure({
  fetchImpl: async () => tokenResponse({ ok: false, status: 401, text: async () => "bad" }),
  pattern: /401/,
});
await startFailure({
  fetchImpl: async () => tokenResponse({ text: async () => JSON.stringify({ url: "wss://livekit.test" }) }),
  pattern: /did not mint/,
});
await startFailure({
  chromeOverrides: { offscreen: {} },
  pattern: /not supported/,
});
const rejected = await startFailure({
  chromeOverrides: {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async () => ({ ok: false, error: "connect rejected" }),
    },
  },
  pattern: /connect rejected/,
});
assert.equal(rejected.calls.create.length, 1);

globalThis.chrome = original.chrome;
globalThis.fetch = original.fetch;

console.log("livekit voice runtime tests passed");
