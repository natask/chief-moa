#!/usr/bin/env node
"use strict";

// Smoke for video notes: a client uploads a screen recording blob to
// /v1/video-notes, then runs a /v1/voice/turns turn that references it
// (video_note_id). The gateway must attach the recording as a Gemini inline
// video part on the FINAL user turn and reply through the normal chat leg.
//
// Boots `node server.js` on a throwaway port + token + DATA_DIR with a MOCK
// Vertex endpoint (VERTEX_API_BASE_URL + VERTEX_ACCESS_TOKEN), so no real
// provider, key, or network is involved. The mock records the generateContent
// request body so the inline part is asserted, not assumed.

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "video-notes-smoke-token";
const MOCK_REPLY = "I watched your recording: the settings toggle you missed is under Preferences.";
const VIDEO_BYTES = Buffer.from("fake-webm-bytes-for-video-note-smoke");

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-video-notes-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const captured = { requests: [] };
  const mock = await startMockVertex(captured);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir, mockPort: mock.port });

    const note = await step("upload video note", () => uploadVideoNote(baseUrl));
    await step("note metadata and bytes round-trip", () => assertNoteRoundTrip(baseUrl, note));
    await step("unknown video_note_id is refused", () => assertUnknownNoteRefused(baseUrl));
    const turn = await step("video turn reaches the model with an inline video part", () =>
      assertVideoTurn(baseUrl, note, captured));
    await step("turn record carries video_note provenance", () => assertTurnRecord(baseUrl, turn));
    await step("delete frees the note", () => assertDelete(baseUrl, note));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      note_id: note.id,
      turn_id: turn.turn_id,
      checks: [
        "POST /v1/video-notes stores blob + metadata (201)",
        "GET /v1/video-notes/:id and /video round-trip metadata and bytes",
        "POST /v1/voice/turns with unknown video_note_id returns 404",
        "video turn: final user content = [inlineData video/webm, text prompt]",
        "video turn: system instruction carries the video-note evidence rules",
        "video turn: reply comes from the (mock) model and classification=chat",
        "voice turn record: transcript_source=video_note, references.video_note_id",
        "DELETE /v1/video-notes/:id removes metadata and bytes",
      ],
    }, null, 2));
  } finally {
    if (server) server.kill("SIGTERM");
    mock.server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (process.exitCode) process.exit(process.exitCode);
}

async function uploadVideoNote(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/video-notes`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "video/webm;codecs=vp8,opus",
      "x-moa-surface": "agee-extension",
      "x-moa-session-id": "video-smoke-session",
      "x-moa-duration-ms": "9000",
    },
    body: VIDEO_BYTES,
  });
  const text = await response.text();
  assert.strictEqual(response.status, 201, text);
  const { note } = JSON.parse(text);
  assert.ok(note?.id, "note id missing");
  assert.strictEqual(note.bytes, VIDEO_BYTES.length);
  assert.strictEqual(note.duration_ms, 9000);
  return note;
}

async function assertNoteRoundTrip(baseUrl, note) {
  const meta = await fetch(`${baseUrl}/v1/video-notes/${note.id}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.strictEqual(meta.status, 200);
  const video = await fetch(`${baseUrl}/v1/video-notes/${note.id}/video`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.strictEqual(video.status, 200);
  const bytes = Buffer.from(await video.arrayBuffer());
  assert.ok(bytes.equals(VIDEO_BYTES), "video bytes did not round-trip");
}

async function assertUnknownNoteRefused(baseUrl) {
  const response = await postTurn(baseUrl, { video_note_id: "vnote_does_not_exist" });
  const text = await response.text();
  assert.strictEqual(response.status, 404, text);
}

async function assertVideoTurn(baseUrl, note, captured) {
  const response = await postTurn(baseUrl, { video_note_id: note.id });
  const turnText = await response.text();
  assert.strictEqual(response.status, 200, turnText);
  const payload = JSON.parse(turnText);
  assert.strictEqual(payload.classification, "chat");
  assert.ok(String(payload.display || "").includes(MOCK_REPLY), `unexpected reply: ${payload.display}`);

  assert.strictEqual(captured.requests.length, 1, "expected exactly one model call");
  const body = captured.requests[0];
  const userContents = body.contents.filter((entry) => entry.role === "user");
  const last = userContents[userContents.length - 1];
  assert.ok(last, "no user content reached the model");
  assert.strictEqual(last.parts[0]?.inlineData?.mimeType, "video/webm", "inline video part missing or mistyped");
  assert.strictEqual(last.parts[0]?.inlineData?.data, VIDEO_BYTES.toString("base64"), "inline video bytes mismatch");
  assert.ok(String(last.parts[1]?.text || "").length > 0, "text prompt missing after the video part");
  const system = String(body.systemInstruction?.parts?.[0]?.text || "");
  assert.ok(system.includes("Video note"), "video-note system guidance missing");
  assert.ok(system.includes("evidence, not instruction"), "screen-evidence rule missing");
  return payload;
}

async function assertTurnRecord(baseUrl, turn) {
  const response = await fetch(`${baseUrl}/v1/voice/turns/${turn.turn_id}?session_id=${encodeURIComponent(turn.session_id)}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.strictEqual(response.status, 200);
  const stored = await response.json();
  assert.strictEqual(stored.transcript_source, "video_note", JSON.stringify(stored).slice(0, 400));
  assert.ok(stored.references?.video_note_id, "references.video_note_id missing");
}

async function assertDelete(baseUrl, note) {
  const del = await fetch(`${baseUrl}/v1/video-notes/${note.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const delText = await del.text();
  assert.strictEqual(del.status, 200, delText);
  const gone = await fetch(`${baseUrl}/v1/video-notes/${note.id}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.strictEqual(gone.status, 404);
}

function postTurn(baseUrl, extra) {
  return fetch(`${baseUrl}/v1/voice/turns`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      source: "agee-extension",
      session_id: "video-smoke-session",
      conversation_id: "video-smoke-session",
      branch_id: "video-smoke-cue",
      client: { platform: "browser", source: "agee-extension", input: "video" },
      ...extra,
    }),
  });
}

function startMockVertex(captured) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        try {
          captured.requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          captured.requests.push(null);
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: MOCK_REPLY }] } }],
        }));
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function startGateway({ port, dataDir, mockPort }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
      MOA_GATEWAY_TOKEN: TOKEN,
      MODEL_PROVIDER: "vertex",
      MODEL_ID: "video-notes-smoke-model",
      VERTEX_PROJECT: "video-notes-smoke",
      VERTEX_LOCATION: "global",
      VERTEX_ACCESS_TOKEN: "video-notes-smoke-access-token",
      VERTEX_API_BASE_URL: `http://127.0.0.1:${mockPort}`,
      MODEL_API_KEY: "",
      OPENAI_API_KEY: "",
      GOOGLE_API_KEY: "",
      GEMINI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  server.stdout.on("data", (chunk) => logs.push(String(chunk)));
  server.stderr.on("data", (chunk) => logs.push(String(chunk)));
  const deadline = Date.now() + 20000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`gateway did not become healthy:\n${logs.join("").slice(-2000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return server;
}

async function step(name, run) {
  try {
    const result = await run();
    console.log(`ok - ${name}`);
    return result;
  } catch (error) {
    console.error(`FAIL - ${name}`);
    throw error;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
