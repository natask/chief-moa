import assert from "node:assert/strict";

const original = { chrome: globalThis.chrome, document: globalThis.document };
const sent = [];
let listener = null;
let appended = 0;
let removed = 0;
let sendFailure = false;
globalThis.chrome = {
  runtime: {
    onMessage: { addListener(value) { listener = value; } },
    async sendMessage(message) {
      sent.push(message);
      if (sendFailure) throw new Error("background unavailable");
    },
  },
};
globalThis.document = {
  body: { appendChild() { appended += 1; } },
  createElement(tag) {
    assert.equal(tag, "audio");
    return {
      autoplay: false,
      srcObject: "stream",
      remove() { removed += 1; },
    };
  },
};

const runtime = await import(`../extension/offscreen-livekit.js?test=${Date.now()}`);
assert.equal(runtime.mapAgentState("thinking"), "thinking");
assert.equal(runtime.mapAgentState("INITIALIZING"), "thinking");
assert.equal(runtime.mapAgentState("speaking"), "speaking");
assert.equal(runtime.mapAgentState("idle"), "listening");
assert.equal(runtime.mapAgentState(null), "listening");

const audio = runtime.ensureAudioElement();
assert.equal(audio.autoplay, true);
assert.equal(runtime.ensureAudioElement(), audio);
assert.equal(appended, 1);
sendFailure = true;
runtime.post({ id: "ignored", kind: "state" });
await new Promise((resolve) => setImmediate(resolve));
sendFailure = false;

class FakeRoom {
  static instances = [];
  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.mic = [];
    this.connectCalls = [];
    this.disconnectCalls = 0;
    this.disconnectFailure = false;
    this.localParticipant = {
      setMicrophoneEnabled: async (...args) => { this.mic.push(args); },
    };
    FakeRoom.instances.push(this);
  }
  on(event, handler) { this.handlers.set(event, handler); }
  async connect(...args) { this.connectCalls.push(args); }
  async disconnect() {
    this.disconnectCalls += 1;
    if (this.disconnectFailure) throw new Error("disconnect failed");
  }
}

await runtime.connect({ id: "live-1", url: "wss://livekit.test", token: "token" }, FakeRoom);
const room = FakeRoom.instances[0];
assert.deepEqual(room.options, { adaptiveStream: true, dynacast: true });
assert.deepEqual(room.mic, [[true, { preConnectBuffer: true }]]);
assert.deepEqual(room.connectCalls, [["wss://livekit.test", "token"]]);
assert.deepEqual(sent.at(-1), { cmd: "livekitOffscreenEvent", id: "live-1", kind: "connected" });

const handlers = [...room.handlers.values()];
assert.equal(handlers.length, 3);
const attributesHandler = handlers[0];
attributesHandler({}, null);
attributesHandler({}, { attributes: {} });
attributesHandler({}, { attributes: { "lk.agent.state": "thinking" } });
assert.deepEqual(sent.at(-1), { cmd: "livekitOffscreenEvent", id: "live-1", kind: "state", state: "thinking" });

let attached = 0;
let attachedElement = null;
const trackHandler = handlers[1];
trackHandler({ kind: "video", attach() { attached += 1; } });
trackHandler({ kind: "audio", attach(element) { attachedElement = element; attached += 1; } });
assert.equal(attached, 1);
assert.equal(attachedElement, runtime.ensureAudioElement());
assert.equal(sent.at(-1).state, "speaking");
handlers[2]();
assert.equal(sent.at(-1).kind, "disconnected");

room.disconnectFailure = true;
attachedElement.remove = () => { removed += 1; throw new Error("already removed"); };
await runtime.teardown();
assert.equal(room.disconnectCalls, 1);
assert.equal(removed, 2);
await runtime.teardown();

assert.equal(listener({ cmd: "other" }, {}, () => {}), false);
let response = null;
assert.equal(listener({ cmd: "livekitConnect", id: "message", url: "bad", token: "bad" }, {}, (value) => { response = value; }), true);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(response.ok, false);
assert.equal(sent.at(-1).kind, "error");

response = null;
assert.equal(listener({ cmd: "livekitDisconnect" }, {}, (value) => { response = value; }), true);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(response, { ok: true });

globalThis.chrome = original.chrome;
globalThis.document = original.document;

console.log("offscreen LiveKit runtime tests passed");
