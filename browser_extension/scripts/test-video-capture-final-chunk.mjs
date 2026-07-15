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

function createHarness({ finalChunk = "terminal", finalChunks = null, deferStop = false } = {}) {
  const listenerBox = { listener: null };
  const recorders = [];
  const pendingRecorderStops = [];
  const runtimeMessages = [];
  const uploads = [];
  const videoTracks = [new FakeTrack("video"), new FakeTrack("video")];
  const audioTracks = [new FakeTrack("audio"), new FakeTrack("audio")];
  const streams = [
    new FakeStream([videoTracks[0]]),
    new FakeStream([audioTracks[0]]),
    new FakeStream([videoTracks[1]]),
    new FakeStream([audioTracks[1]]),
  ];

  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }

    constructor(_stream, options = {}) {
      this.finalChunk = finalChunks?.[recorders.length] ?? finalChunk;
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
      const finish = () => {
        this.emitChunk(this.finalChunk);
        this.onstop?.();
      };
      if (deferStop) pendingRecorderStops.push(finish);
      else queueMicrotask(finish);
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
    AbortController,
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

  function finishRecorderStop() {
    const finish = pendingRecorderStops.shift();
    if (!finish) throw new Error("no recorder stop is pending");
    finish();
  }

  return {
    dispatch,
    finishRecorderStop,
    recorders,
    runtimeMessages,
    uploads,
    videoTrack: videoTracks[0],
    audioTrack: audioTracks[0],
    videoTracks,
    audioTracks,
  };
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
  return harness.recorders.at(-1);
}

async function stopAndUpload(harness, videoSessionId = "video-1") {
  return harness.dispatch({
    cmd: "offscreenVideoCaptureStop",
    videoSessionId,
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

test("an over-cap terminal chunk rejects the complete WebM without uploading or truncating it", async () => {
  const harness = createHarness({ finalChunk: "terminal-over-cap" });
  const recorder = await start(harness, { maxBytes: 4 });
  const result = await stopAndUpload(harness);

  assert.equal(result.stored, false);
  assert.equal(result.capped, true);
  assert.equal(recorder.stopCount, 1);
  assert.match(result.error, /exceeded the 4-byte limit and was not uploaded/);
  assert.equal(harness.uploads.length, 0);
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

test("discard during pending recorder stop cancels terminalization before upload", async () => {
  const harness = createHarness({ finalChunk: "late-discarded-final", deferStop: true });
  const recorder = await start(harness);

  const stopping = stopAndUpload(harness);
  await Promise.resolve();
  const discarded = await harness.dispatch({
    cmd: "offscreenVideoCaptureDiscard",
    videoSessionId: "video-1",
  });
  harness.finishRecorderStop();
  const result = await stopping;

  assert.equal(discarded.ok, true);
  assert.equal(result.stored, false);
  assert.match(result.error, /discarded/);
  assert.equal(recorder.stopCount, 1);
  assert.equal(harness.uploads.length, 0);
  assert.ok(harness.videoTrack.stopCount >= 1);
  assert.ok(harness.audioTrack.stopCount >= 1);
});

test("a late terminal event stays isolated from a replacement capture", async () => {
  const harness = createHarness({ finalChunks: ["old-final", "new-final"], deferStop: true });
  await start(harness);
  const oldStop = stopAndUpload(harness);
  await Promise.resolve();

  await start(harness, { videoSessionId: "video-2" });
  harness.finishRecorderStop();
  const oldResult = await oldStop;
  assert.equal(oldResult.stored, true);

  const newStop = stopAndUpload(harness, "video-2");
  harness.finishRecorderStop();
  const newResult = await newStop;
  assert.equal(newResult.stored, true);

  assert.equal(harness.uploads.length, 2);
  assert.equal(await harness.uploads[0].options.body.text(), "old-final");
  assert.equal(await harness.uploads[1].options.body.text(), "new-final");
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
