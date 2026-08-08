"use strict";

// Test-only child-process preload for eval-voice-e2e.js. It replaces the
// Google Speech v2 client with a deterministic bidi stream while leaving the
// gateway's production streaming-STT orchestration untouched.

const { EventEmitter } = require("node:events");
const Module = require("node:module");

const transcript = String(process.env.MOA_TEST_STREAMING_STT_TRANSCRIPT || "").trim();
const languageCode = String(process.env.MOA_TEST_STREAMING_STT_LANGUAGE || "en-US").trim() || "en-US";
const originalLoad = Module._load;

class FakeStreamingRecognizeCall extends EventEmitter {
  constructor() {
    super();
    this.audioBytes = 0;
    this.partialSent = false;
    this.closed = false;
  }

  write(message) {
    const audio = Buffer.isBuffer(message?.audio) ? message.audio : null;
    if (audio) {
      this.audioBytes += audio.length;
      if (!this.partialSent && transcript) {
        this.partialSent = true;
        setImmediate(() => {
          this.emit("data", {
            results: [{ alternatives: [{ transcript }], isFinal: false, languageCode }],
          });
        });
      }
    }
    return true;
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => {
      if (transcript) {
        this.emit("data", {
          results: [{
            alternatives: [{ transcript }],
            isFinal: true,
            languageCode,
            resultEndOffset: { seconds: 1, nanos: 0 },
          }],
        });
      }
      this.emit("end");
    });
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => this.emit("close"));
  }
}

class FakeSpeechClient {
  _streamingRecognize() {
    return new FakeStreamingRecognizeCall();
  }

  streamingRecognize() {
    throw new Error("the generated v2 bidi method must be used");
  }
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "@google-cloud/speech") {
    return { v2: { SpeechClient: FakeSpeechClient } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
