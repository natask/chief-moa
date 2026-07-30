"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WebSocket } = require("ws");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const AUDIO_FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };

function invocationContext() {
  return {
    schema: "moa.browser-invocation-context.v1",
    input: "voice",
    tab_id: 9,
    captured_at: "2026-07-29T19:00:00.000Z",
    page: { url: "https://tasks.example.test/page-b", title: "Page B", snapshot_id: "snap-b" },
    snapshot: {
      snapshot_id: "snap-b",
      url: "https://tasks.example.test/page-b",
      title: "Page B",
      page_text: "The task visible when the user finalized voice.",
      document_context: { scope: "whole_rendered_document", coverage: "complete", complete: true, truncated: false },
      elements: [], element_summaries: [], viewport: { width: 900, height: 700, scrollX: 0, scrollY: 0 },
      captured_at: "2026-07-29T19:00:00.000Z",
    },
  };
}

function provider(seen) {
  return {
    status: () => ({ provider: "browser-voice-test", model: "test", configured: true, assistant_audio_format: AUDIO_FORMAT }),
    async processTurn(turn, hooks) {
      seen.contextPrompt = turn.contextPrompt;
      seen.invocationContext = turn.invocationContext;
      await hooks.onTranscriptFinal("what page was I on?");
      await hooks.onToolCall({ id: "tool-context", name: "launch_agent_run", args: { prompt: "inspect it" } });
      await hooks.onAssistantText("Page B");
      return {
        provider: "browser-voice-test", model: "test", transcript: "what page was I on?",
        assistant_text: "Page B", audio_format: AUDIO_FORMAT,
      };
    },
  };
}

test("browser commit_turn binds send-time context into reasoning and the canonical voice turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-browser-voice-context-"));
  const seen = {};
  const completed = [];
  const voiceServer = createVoiceSessionServer({
    dataDir: path.join(root, "data"),
    voiceProvider: provider(seen),
    contextProvider: () => "Prior session context.",
    toolHandler: (call) => { seen.toolCall = call; return { ok: true }; },
    onTurnCompleted: (turn) => completed.push(turn),
  });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => voiceServer.handleUpgrade(request, socket, head));
  try {
    const port = await listen(server);
    await runTurn(`ws://127.0.0.1:${port}${voiceServer.endpoint}`);
    assert.equal(seen.invocationContext.page.url, "https://tasks.example.test/page-b");
    assert.match(seen.contextPrompt, /Prior session context/);
    assert.match(seen.contextPrompt, /captured when this exact message was submitted/);
    assert.match(seen.contextPrompt, /Page B/);
    assert.equal(seen.toolCall.invocation_context.digest, seen.invocationContext.digest);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].invocation_context.page.url, "https://tasks.example.test/page-b");
    assert.equal(completed[0].invocation_context.executable, false);
    assert.equal(completed[0].context.invocation_context_digest, completed[0].invocation_context.digest);
  } finally {
    await new Promise((resolve) => voiceServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function runTurn(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error("voice turn timed out")), 5000);
    ws.on("open", () => ws.send(JSON.stringify({
      type: "session_start", source: "agee-extension", session_id: "session", conversation_id: "session",
      branch_id: "default", turn_id: "turn-b", format: AUDIO_FORMAT,
    })));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      if (event.type === "error") {
        clearTimeout(timeout); reject(new Error(event.message)); return;
      }
      if (event.type === "session_ready") {
        ws.send(Buffer.from([0, 0]));
        ws.send(JSON.stringify({ type: "commit_turn", turn_id: "turn-b", invocation_context: invocationContext() }));
      }
      if (event.type === "turn_done") {
        clearTimeout(timeout); ws.close(); resolve();
      }
    });
    ws.on("error", reject);
  });
}
