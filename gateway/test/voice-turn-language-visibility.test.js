"use strict";

// turn_done must ALWAYS carry reply_language and input_languages so an
// Android/browser overlay can render a live "hears X / speaks Y" indicator every
// turn. reply_language falls back to the turn's effective profile reply language
// when the provider result omits it; input_languages comes from the restricted
// STT language codes captured at session start.

const assert = require("node:assert");
const test = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const AUDIO_FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };
const INPUT_LANGUAGES = ["am-ET", "en-US"];

// A cascaded-style provider that returns assistant text but NO reply_language,
// forcing the gateway's effective-profile fallback. Its status advertises the
// restricted STT language codes for the session.
function noReplyLanguageProvider() {
  return {
    status() {
      return {
        provider: "lang-visibility-test",
        model: "lang-visibility-model",
        configured: true,
        assistant_audio_format: AUDIO_FORMAT,
        language_codes: INPUT_LANGUAGES.slice(),
      };
    },
    async processTurn(turn, hooks) {
      const transcript = String(turn.syntheticText || "").trim();
      await hooks.onTranscriptFinal(transcript);
      await hooks.onAssistantText(`reply: ${transcript}`);
      // Deliberately omit reply_language: the gateway must still populate it.
      return {
        provider: "lang-visibility-test",
        model: "lang-visibility-model",
        transcript,
        assistant_text: `reply: ${transcript}`,
        audio_format: AUDIO_FORMAT,
      };
    },
  };
}

// Reply language lives on the effective agent profile (am-ET), separate from the
// input STT languages.
function amharicReplyProfile() {
  return {
    effective: () => ({ language_primary: "am-ET", language: "am-ET" }),
    currentVersion: () => "profile_v0001",
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeHttpServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function closeVoiceServer(voiceServer) {
  if (voiceServer && typeof voiceServer.close === "function") {
    await voiceServer.close();
  }
}

function runTextTurn(target, { text }) {
  const events = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`timed out waiting for ${target}`));
    }, 5000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session_start",
        session_id: "lang_vis_session",
        conversation_id: "lang_vis_session",
        branch_id: "lang_vis_branch",
        turn_id: "lang_vis_1",
        source: "voice-lang-visibility-test",
        format: AUDIO_FORMAT,
      }));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      if (event.type === "error") {
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        reject(new Error(event.message || "voice session returned error"));
        return;
      }
      events.push(event);
      if (event.type === "session_ready") {
        ws.send(JSON.stringify({ type: "text_turn", turn_id: "lang_vis_1", text }));
      }
      if (event.type === "turn_done") {
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve(events);
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test("turn_done always carries reply_language and input_languages", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-lang-vis-"));
  const voiceServer = createVoiceSessionServer({
    dataDir: path.join(tempDir, "data"),
    voiceProvider: noReplyLanguageProvider(),
    agentProfile: amharicReplyProfile(),
    onTurnCompleted: () => null,
  });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === voiceServer.endpoint) {
      voiceServer.handleUpgrade(request, socket, head);
      return;
    }
    socket.destroy();
  });

  try {
    const port = await listen(server);
    const events = await runTextTurn(`ws://127.0.0.1:${port}${voiceServer.endpoint}`, { text: "hello" });

    const turnDone = events.find((event) => event.type === "turn_done");
    assert.ok(turnDone, "turn_done event must be delivered");
    assert.equal(turnDone.status, "completed");

    // Provider omitted reply_language: the gateway falls back to the effective
    // profile reply language rather than leaving the field off.
    assert.equal(turnDone.reply_language, "am-ET", "reply_language must fall back to the effective profile");
    assert.ok(Object.prototype.hasOwnProperty.call(turnDone, "input_languages"), "input_languages must always be present");
    assert.deepEqual(turnDone.input_languages, INPUT_LANGUAGES, "input_languages must carry the restricted STT codes");
  } finally {
    await closeVoiceServer(voiceServer);
    await closeHttpServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
