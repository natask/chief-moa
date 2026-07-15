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

test("Note admission returns storage guidance before provider construction or audio capture", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-note-session-admission-"));
  const dataDir = path.join(tempDir, "data");
  let providerFactoryCalls = 0;
  let providerSessionCalls = 0;
  const voiceServer = createVoiceSessionServer({
    dataDir,
    voiceProviderFactory: () => {
      providerFactoryCalls += 1;
      return {
        status: () => ({ provider: "must-not-start" }),
        createLiveTurnSession: () => {
          providerSessionCalls += 1;
          throw new Error("provider session must not start in Note mode");
        },
      };
    },
    voiceModeAdmission: (deviceId) => ({
      mode: deviceId === "note-phone" ? "note" : "ask",
      version: "voice_mode_v0001",
      routing: deviceId === "note-phone"
        ? {
          response_policy: "none",
          provider_work_allowed: false,
          storage_policy: "audio_note",
          assistant_reply_allowed: false,
          agent_launch_allowed: false,
          capture_endpoint: "/v1/audio-notes",
        }
        : { response_policy: "normal", provider_work_allowed: true },
    }),
  });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => voiceServer.handleUpgrade(request, socket, head));

  try {
    const port = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    const events = await noteSession(`ws://127.0.0.1:${port}${voiceServer.endpoint}`);
    const admission = events.find((event) => event.type === "mode_admission");
    assert.ok(admission, "Note must emit an explicit mode admission decision");
    assert.equal(admission.status, "note_capture_required");
    assert.equal(admission.routing.provider_work_allowed, false);
    assert.deepEqual(admission.action, { type: "capture_audio_note", endpoint: "/v1/audio-notes" });
    assert.equal(events.at(-1).type, "turn_done");
    assert.equal(events.at(-1).status, "note_capture_required");
    assert.equal(providerFactoryCalls, 0, "Note must not construct the selected voice provider");
    assert.equal(providerSessionCalls, 0, "Note must not open a provider socket/session");
    assert.equal(fs.existsSync(path.join(dataDir, "voice-sessions", "note-session")), false, "Note must not create a conversational audio directory");
  } finally {
    await new Promise((resolve) => voiceServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function noteSession(target) {
  return new Promise((resolve, reject) => {
    const events = [];
    const socket = new WebSocket(target);
    const timeout = setTimeout(() => reject(new Error("timed out waiting for Note admission")), 3000);
    socket.on("open", () => {
      socket.send(Buffer.alloc(320));
      socket.send(JSON.stringify({
        type: "session_start",
        session_id: "note-session",
        branch_id: "default",
        turn_id: "note-turn",
        device_id: "note-phone",
        format: FORMAT,
      }));
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      events.push(event);
      if (event.type === "turn_done") {
        clearTimeout(timeout);
        socket.close();
        resolve(events);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
