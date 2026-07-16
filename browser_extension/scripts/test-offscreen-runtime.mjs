import assert from "node:assert/strict";

const original = {
  AudioWorkletNode: globalThis.AudioWorkletNode,
  Blob: globalThis.Blob,
  MediaRecorder: globalThis.MediaRecorder,
  MediaStream: globalThis.MediaStream,
  chrome: globalThis.chrome,
  fetch: globalThis.fetch,
  navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  window: globalThis.window,
};

let listener = null;
const sent = [];
globalThis.chrome = {
  runtime: {
    getURL: (path) => `chrome-extension://test/${path}`,
    onMessage: { addListener(value) { listener = value; } },
    async sendMessage(message) { sent.push(message); },
  },
};

let timerCallback = null;
let timerClears = 0;
globalThis.setTimeout = (callback) => { timerCallback = callback; return { timer: true }; };
globalThis.clearTimeout = () => { timerClears += 1; };

function track({ stopThrows = false } = {}) {
  return {
    stopped: 0,
    ended: null,
    stop() { this.stopped += 1; if (stopThrows) throw new Error("already stopped"); },
    addEventListener(type, callback) { if (type === "ended") this.ended = callback; },
  };
}

function stream({ video = [], audio = [], all = [...video, ...audio] } = {}) {
  return {
    getTracks: () => all,
    getVideoTracks: () => video,
    getAudioTracks: () => audio,
  };
}

let mediaQueue = [];
const navigator = {
  mediaDevices: {
    async getUserMedia() {
      const next = mediaQueue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  },
};
Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });

let workletNode = null;
class FakeAudioWorkletNode {
  constructor(context, name, options) {
    this.context = context;
    this.name = name;
    this.options = options;
    this.connected = null;
    this.disconnected = 0;
    this.port = { onmessage: null, closed: 0, close() { this.closed += 1; } };
    workletNode = this;
  }
  connect(value) { this.connected = value; }
  disconnect() { this.disconnected += 1; }
}
globalThis.AudioWorkletNode = FakeAudioWorkletNode;

let audioContext = null;
class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.destination = { id: "destination" };
    this.modules = [];
    this.closed = 0;
    this.audioWorklet = { addModule: async (url) => { this.modules.push(url); } };
    this.source = { connected: null, disconnected: 0, connect: (value) => { this.source.connected = value; }, disconnect: () => { this.source.disconnected += 1; } };
    audioContext = this;
  }
  createMediaStreamSource() { return this.source; }
  async close() { this.closed += 1; }
}
globalThis.window = { AudioContext: FakeAudioContext };

class FakeMediaStream {
  constructor(tracks) { this.tracks = tracks; }
}
globalThis.MediaStream = FakeMediaStream;

let recorder = null;
class FakeMediaRecorder {
  static supported = new Set(["video/webm;codecs=vp8,opus"]);
  static isTypeSupported(value) { return FakeMediaRecorder.supported.has(value); }
  constructor(combined, options) {
    this.combined = combined;
    this.options = options;
    this.mimeType = options.mimeType || "";
    this.state = "inactive";
    this.started = [];
    this.stopCalls = 0;
    this.ondataavailable = null;
    this.onstop = null;
    recorder = this;
  }
  start(interval) { this.state = "recording"; this.started.push(interval); }
  stop() {
    this.stopCalls += 1;
    this.state = "inactive";
    this.onstop?.();
  }
  data(blob) { this.ondataavailable?.({ data: blob }); }
}
globalThis.MediaRecorder = FakeMediaRecorder;
globalThis.window.MediaRecorder = FakeMediaRecorder;

const runtime = await import(`../extension/offscreen.js?test=${Date.now()}`);

assert.equal(runtime.captureFailure(Object.assign(new Error("denied"), { name: "NotAllowedError" }), "user_media").code, "microphone_permission_denied");
assert.equal(runtime.captureFailure(Object.assign(new Error("busy"), { name: "NotReadableError" }), "user_media").code, "microphone_capture_failed");
assert.equal(runtime.captureFailure(Object.assign(new Error("denied"), { name: "NotAllowedError" }), "audio_runtime").code, "microphone_capture_failed");
assert.equal(runtime.captureFailure("raw failure", "user_media").message, "raw failure");
assert.equal(runtime.captureFailure(null, "user_media").message, "microphone capture failed");
assert.equal(runtime.bytesToBase64(new Uint8Array([65, 66]).buffer), "QUI=");
assert.equal(runtime.bytesToBase64(null), "");
assert.equal(runtime.resampleToPcm16(null, 48000, 16000, {}).byteLength, 0);
assert.equal(runtime.resampleToPcm16(new Float32Array([1]), 0, 16000, {}).byteLength, 0);
const resample = { offset: -2 };
const pcm = new Int16Array(runtime.resampleToPcm16(new Float32Array([-2, -0.5, 0.5, 2]), 16000, 16000, resample));
assert.deepEqual([...pcm], [-32768, -16384, 16383, 32767]);
assert.equal(resample.offset, 0);
const interpolated = new Int16Array(runtime.resampleToPcm16(new Float32Array([0, 1]), 8000, 16000, { offset: 0.5 }));
assert.ok(interpolated.length > 0);

await assert.rejects(runtime.startCapture(""), /missing voice session/);
const voiceTrack = track();
mediaQueue = [stream({ all: [voiceTrack] })];
await runtime.startCapture("voice-1");
assert.equal(audioContext.modules[0], "chrome-extension://test/offscreen-audio-worklet.js");
assert.equal(workletNode.name, "aggie-voice-capture");
assert.equal(audioContext.source.connected, workletNode);
assert.equal(workletNode.connected, audioContext.destination);
workletNode.port.onmessage({ data: null });
workletNode.port.onmessage({ data: { samples: new Float32Array() } });
workletNode.port.onmessage({ data: { samples: new Float32Array([0.25, -0.25, 0.5]) } });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(sent.at(-1).cmd, "offscreenVoiceAudio");
assert.equal(sent.at(-1).voiceSessionId, "voice-1");
runtime.stopCapture("other");
assert.equal(voiceTrack.stopped, 0);
runtime.stopCapture("voice-1");
assert.equal(voiceTrack.stopped, 1);
assert.equal(workletNode.port.closed, 1);
assert.equal(audioContext.closed, 1);
runtime.stopCapture();

const cleanupTrack = track({ stopThrows: true });
mediaQueue = [stream({ all: [cleanupTrack] })];
await runtime.startCapture("voice-cleanup-errors");
workletNode.port.close = () => { throw new Error("port already closed"); };
workletNode.disconnect = () => { throw new Error("worklet already disconnected"); };
audioContext.source.disconnect = () => { throw new Error("source already disconnected"); };
audioContext.close = () => { throw new Error("context already closed"); };
runtime.stopCapture("voice-cleanup-errors");

mediaQueue = [stream({ all: [track()] }), stream({ all: [track()] })];
await runtime.startCapture("voice-stale-1");
const staleVoiceHandler = workletNode.port.onmessage;
await runtime.startCapture("voice-stale-2");
staleVoiceHandler({ data: { samples: new Float32Array([0.5]) } });
runtime.stopCapture("voice-stale-2");

class ZeroRateAudioContext extends FakeAudioContext {
  constructor() { super(); this.sampleRate = 0; }
}
globalThis.window = { AudioContext: ZeroRateAudioContext, MediaRecorder: FakeMediaRecorder };
mediaQueue = [stream({ all: [track()] })];
await runtime.startCapture("voice-zero-rate");
workletNode.port.onmessage({ data: { samples: new Float32Array([0.5]) } });
runtime.stopCapture("voice-zero-rate");

mediaQueue = [stream({ all: [track({ stopThrows: true })] })];
globalThis.window = {};
await assert.rejects(runtime.startCapture("voice-2"), /Web Audio/);
globalThis.window = { AudioContext: class extends FakeAudioContext { constructor() { super(); this.audioWorklet = null; } }, MediaRecorder: FakeMediaRecorder };
mediaQueue = [stream({ all: [track()] })];
await assert.rejects(runtime.startCapture("voice-3"), /AudioWorklet/);
mediaQueue = [new Error("mic denied")];
await assert.rejects(runtime.startCapture("voice-4"), /mic denied/);
globalThis.window = { AudioContext: FakeAudioContext, MediaRecorder: FakeMediaRecorder };

runtime.stopVideoTracks({});
runtime.stopVideoTracks({ screenStream: stream({ all: [track({ stopThrows: true })] }) });

assert.equal(runtime.pickVideoMimeType(), "video/webm;codecs=vp8,opus");
FakeMediaRecorder.supported.clear();
assert.equal(runtime.pickVideoMimeType(), "");
FakeMediaRecorder.supported.add("video/webm;codecs=vp8,opus");
await assert.rejects(runtime.startVideoCapture({ streamId: "stream" }), /missing video session/);
await assert.rejects(runtime.startVideoCapture({ videoSessionId: "video" }), /missing desktop/);

async function beginVideo({ id = "video-1", maxBytes = 100, maxMs = 1000, screenTrack = track(), micTrack = track() } = {}) {
  mediaQueue = [stream({ video: [screenTrack] }), stream({ audio: [micTrack] })];
  await runtime.startVideoCapture({ videoSessionId: id, streamId: "desktop", maxBytes, maxMs });
  return { screenTrack, micTrack, recorder };
}

let video = await beginVideo();
assert.deepEqual(video.recorder.started, [1000]);
assert.equal(video.recorder.options.mimeType, "video/webm;codecs=vp8,opus");
video.recorder.data(null);
video.recorder.data(new Blob([]));
video.recorder.data(new Blob(["hello"], { type: "video/webm" }));
assert.equal(video.recorder.state, "recording");
video.screenTrack.ended();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(sent.at(-1).cmd, "offscreenVideoEnded");

globalThis.fetch = async (url, options) => {
  assert.equal(url, "https://gateway.test/v1/video-notes");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.authorization, "Bearer token");
  assert.equal(options.headers["x-moa-session-id"], "session");
  return { ok: true, status: 201, text: async () => JSON.stringify({ note: { id: "note" } }) };
};
const uploaded = await runtime.stopAndUploadVideoCapture({
  videoSessionId: "video-1", gatewayUrl: "https://gateway.test", gatewayToken: "token", sessionId: "session",
});
assert.equal(uploaded.stored, true);
assert.equal(uploaded.note.id, "note");
assert.equal(uploaded.capped, false);

assert.deepEqual(await runtime.stopAndUploadVideoCapture({}), { stored: false, error: "No video recording is in progress." });
video = await beginVideo({ id: "empty" });
assert.match((await runtime.stopAndUploadVideoCapture({ videoSessionId: "empty", gatewayUrl: "https://gateway.test" })).error, /No video was captured/);

video = await beginVideo({ id: "no-gateway" });
video.recorder.data(new Blob(["x"]));
assert.match((await runtime.stopAndUploadVideoCapture({ videoSessionId: "no-gateway" })).error, /No gateway URL/);

video = await beginVideo({ id: "network" });
video.recorder.data(new Blob(["x"]));
globalThis.fetch = async () => { throw "offline"; };
assert.match((await runtime.stopAndUploadVideoCapture({ videoSessionId: "network", gatewayUrl: "https://gateway.test" })).error, /offline/);

video = await beginVideo({ id: "http" });
video.recorder.data(new Blob(["x"]));
globalThis.fetch = async () => ({ ok: false, status: 413, text: async () => "too large" });
assert.match((await runtime.stopAndUploadVideoCapture({ videoSessionId: "http", gatewayUrl: "https://gateway.test" })).error, /413/);

video = await beginVideo({ id: "invalid-json" });
video.recorder.data(new Blob(["x"]));
globalThis.fetch = async () => ({ ok: true, status: 201, text: async () => "not-json" });
assert.deepEqual((await runtime.stopAndUploadVideoCapture({ videoSessionId: "invalid-json", gatewayUrl: "https://gateway.test" })).note, null);

video = await beginVideo({ id: "size-cap", maxBytes: 1 });
video.recorder.data(new Blob(["large"]));
assert.equal(video.recorder.stopCalls, 1);
globalThis.fetch = async () => ({ ok: true, status: 201, text: async () => "{}" });
assert.equal((await runtime.stopAndUploadVideoCapture({ videoSessionId: "size-cap", gatewayUrl: "https://gateway.test" })).capped, true);

video = await beginVideo({ id: "time-cap" });
timerCallback();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(video.recorder.stopCalls, 1);
assert.equal(sent.at(-1).cmd, "offscreenVideoEnded");
runtime.discardVideoCapture("other");
runtime.discardVideoCapture("time-cap");
runtime.discardVideoCapture();

video = await beginVideo({ id: "inactive-discard" });
video.recorder.state = "inactive";
runtime.discardVideoCapture("inactive-discard");

video = await beginVideo({ id: "throwing-discard" });
video.recorder.stop = () => { throw new Error("already stopped"); };
runtime.discardVideoCapture("throwing-discard");

FakeMediaRecorder.supported.clear();
mediaQueue = [stream({ video: [track()] }), stream({ audio: [track()] })];
await runtime.startVideoCapture({ videoSessionId: "defaults", streamId: "desktop", maxBytes: null, maxMs: null });
assert.equal(recorder.options.mimeType, undefined);
recorder.data(new Blob(["x"]));
globalThis.fetch = async (_url, options) => {
  assert.equal(options.headers["content-type"], "video/webm");
  return { ok: true, status: 201, text: async () => "{}" };
};
await runtime.stopAndUploadVideoCapture({ videoSessionId: "defaults", gatewayUrl: "https://gateway.test" });
FakeMediaRecorder.supported.add("video/webm;codecs=vp8,opus");

mediaQueue = [stream({ video: [track()] }), new Error("mic unavailable")];
await assert.rejects(
  runtime.startVideoCapture({ videoSessionId: "video-start-failure", streamId: "desktop" }),
  /mic unavailable/,
);

const inactive = { recorder: { state: "inactive" } };
await runtime.waitForVideoRecorderStop(inactive);
const throwing = { recorder: { state: "recording", stop() { throw new Error("stop failed"); } }, stopWaiters: [] };
await runtime.waitForVideoRecorderStop(throwing);

function dispatch(message) {
  return new Promise((resolve) => {
    const handled = listener(message, {}, resolve);
    if (handled !== true) resolve(handled);
  });
}
assert.equal(await dispatch({ cmd: "other" }), false);
assert.deepEqual(await dispatch({ cmd: "offscreenVoiceReady" }), { ok: true, context: "offscreen" });
assert.deepEqual(await dispatch({ cmd: "offscreenVoiceCaptureStop", voiceSessionId: "none" }), { ok: true });
assert.deepEqual(await dispatch({ cmd: "offscreenVideoCaptureDiscard", videoSessionId: "none" }), { ok: true });
assert.deepEqual(await dispatch({ cmd: "offscreenVoiceCaptureStop" }), { ok: true });
assert.deepEqual(await dispatch({ cmd: "offscreenVideoCaptureDiscard" }), { ok: true });

mediaQueue = [stream({ all: [track()] })];
assert.deepEqual(await dispatch({ cmd: "offscreenVoiceCaptureStart", voiceSessionId: "dispatch-voice" }), { ok: true });
runtime.stopCapture("dispatch-voice");
assert.equal((await dispatch({ cmd: "offscreenVoiceCaptureStart" })).ok, false);

mediaQueue = [stream({ video: [track()] }), stream({ audio: [track()] })];
assert.deepEqual(
  await dispatch({ cmd: "offscreenVideoCaptureStart", videoSessionId: "dispatch-video", streamId: "desktop" }),
  { ok: true },
);
assert.match(
  (await dispatch({ cmd: "offscreenVideoCaptureStop", videoSessionId: "dispatch-video" })).error,
  /No video was captured/,
);
assert.equal((await dispatch({ cmd: "offscreenVideoCaptureStart" })).ok, false);
assert.deepEqual(
  await dispatch({ cmd: "offscreenVideoCaptureStop", videoSessionId: "missing" }),
  { stored: false, error: "No video recording is in progress." },
);
assert.equal(timerClears > 0, true);

globalThis.AudioWorkletNode = original.AudioWorkletNode;
globalThis.Blob = original.Blob;
globalThis.MediaRecorder = original.MediaRecorder;
globalThis.MediaStream = original.MediaStream;
globalThis.chrome = original.chrome;
globalThis.fetch = original.fetch;
if (original.navigatorDescriptor) Object.defineProperty(globalThis, "navigator", original.navigatorDescriptor);
else delete globalThis.navigator;
globalThis.setTimeout = original.setTimeout;
globalThis.clearTimeout = original.clearTimeout;
globalThis.window = original.window;

console.log("offscreen capture runtime tests passed");
