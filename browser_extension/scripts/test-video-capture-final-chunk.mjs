import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const offscreenSource = readFileSync(new URL("../extension/offscreen.js", import.meta.url), "utf8");

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.listeners = new Map();
    this.stopCount = 0;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  end() {
    this.listeners.get("ended")?.();
  }

  stop() {
    this.stopCount += 1;
  }
}

class FakeStream {
  constructor(tracks) {
    this.tracks = tracks;
  }

  getTracks() {
    return this.tracks;
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

function createHarness({ finalChunk = "terminal" } = {}) {
  const listenerBox = { listener: null };
  const recorders = [];
  const runtimeMessages = [];
  const uploads = [];
  const videoTrack = new FakeTrack("video");
  const audioTrack = new FakeTrack("audio");
  const streams = [new FakeStream([videoTrack]), new FakeStream([audioTrack])];

  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }

    constructor(_stream, options = {}) {
      this.mimeType = options.mimeType || "video/webm";
      this.state = "inactive";
      this.ondataavailable = null;
      this.onstop = null;
      this.stopCount = 0;
      recorders.push(this);
    }

    start() {
      this.state = "recording";
    }

    emitChunk(value) {
      this.ondataavailable?.({ data: new Blob([value], { type: this.mimeType }) });
    }

    stop() {
      if (this.state === "inactive") throw new Error("recorder already inactive");
      this.stopCount += 1;
      this.state = "inactive";
      queueMicrotask(() => {
        this.emitChunk(finalChunk);
        this.onstop?.();
      });
    }
  }

  const context = vm.createContext({
    Blob,
    MediaStream: FakeStream,
    MediaRecorder: FakeMediaRecorder,
    AudioWorkletNode: class {},
    URL,
    Uint8Array,
    Int16Array,
    Float32Array,
    ArrayBuffer,
    Date,
    Promise,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          const stream = streams.shift();
          if (!stream) throw new Error("unexpected getUserMedia call");
          return stream;
        },
      },
    },
    chrome: {
      runtime: {
        id: "test-extension",
        getURL(path) {
          return `chrome-extension://test-extension/${path}`;
        },
        onMessage: {
          addListener(listener) {
            listenerBox.listener = listener;
          },
        },
        async sendMessage(message) {
          runtimeMessages.push(message);
          return { ok: true };
        },
      },
    },
    async fetch(url, options) {
      uploads.push({ url, options });
      return {
        ok: true,
        status: 201,
        async text() {
          return JSON.stringify({ note: { id: "note-1" } });
        },
      };
    },
  });
  context.window = context;
  vm.runInContext(offscreenSource, context, { filename: "offscreen.js" });
  assert.equal(typeof listenerBox.listener, "function", "offscreen message listener installed");

  async function dispatch(message) {
    return new Promise((resolve, reject) => {
      let responded = false;
      const keepAlive = listenerBox.listener(message, {}, (response) => {
        responded = true;
        resolve(response);
      });
      if (keepAlive !== true && !responded) reject(new Error(`message was not handled: ${message.cmd}`));
    });
  }

  return { dispatch, recorders, runtimeMessages, uploads, videoTrack, audioTrack };
}

async function start(harness, overrides = {}) {
  const result = await harness.dispatch({
    cmd: "offscreenVideoCaptureStart",
    videoSessionId: "video-1",
    streamId: "desktop-stream",
    maxMs: 60_000,
    maxBytes: 10_000,
    ...overrides,
  });
  assert.equal(result.ok, true);
  assert.equal(harness.recorders.length, 1);
  return harness.recorders[0];
}

async function stopAndUpload(harness) {
  return harness.dispatch({
    cmd: "offscreenVideoCaptureStop",
    videoSessionId: "video-1",
    gatewayUrl: "https://gateway.test",
    gatewayToken: "secret",
    sessionId: "session-1",
  });
}

test("manual stop uploads the terminal chunk for a sub-one-second recording exactly once", async () => {
  const harness = createHarness({ finalChunk: "only-final-chunk" });
  const recorder = await start(harness);

  const result = await stopAndUpload(harness);

  assert.equal(result.stored, true);
  assert.equal(recorder.stopCount, 1);
  assert.equal(harness.uploads.length, 1);
  assert.equal(await harness.uploads[0].options.body.text(), "only-final-chunk");
  const secondStop = await stopAndUpload(harness);
  assert.equal(secondStop.stored, false);
  assert.equal(harness.uploads.length, 1, "a second terminal request cannot upload again");
});

test("a size-cap stop waits for its queued terminal chunk before upload", async () => {
  const harness = createHarness({ finalChunk: "final" });
  const recorder = await start(harness, { maxBytes: 4 });

  recorder.emitChunk("lead");
  assert.equal(recorder.state, "inactive", "cap synchronously requests recorder stop");
  const result = await stopAndUpload(harness);

  assert.equal(result.stored, true);
  assert.equal(result.capped, true);
  assert.equal(recorder.stopCount, 1);
  assert.equal(await harness.uploads[0].options.body.text(), "leadfinal");
});

test("discard ignores the queued terminal chunk and never uploads", async () => {
  const harness = createHarness({ finalChunk: "discarded-final" });
  const recorder = await start(harness);

  const discarded = await harness.dispatch({
    cmd: "offscreenVideoCaptureDiscard",
    videoSessionId: "video-1",
  });
  await Promise.resolve();

  assert.equal(discarded.ok, true);
  assert.equal(recorder.stopCount, 1);
  assert.equal(harness.uploads.length, 0);
  assert.equal(harness.videoTrack.stopCount, 2, "discard and recorder terminalization remain harmlessly idempotent");
  assert.equal(harness.audioTrack.stopCount, 2);
});

test("screen-share track end remains a single terminal upload path", async () => {
  const harness = createHarness({ finalChunk: "track-ended-final" });
  const recorder = await start(harness);

  harness.videoTrack.end();
  assert.equal(harness.runtimeMessages.length, 1);
  assert.equal(harness.runtimeMessages[0].cmd, "offscreenVideoEnded");
  assert.equal(harness.runtimeMessages[0].videoSessionId, "video-1");
  const result = await stopAndUpload(harness);

  assert.equal(result.stored, true);
  assert.equal(recorder.stopCount, 1);
  assert.equal(harness.uploads.length, 1);
  assert.equal(await harness.uploads[0].options.body.text(), "track-ended-final");
});
