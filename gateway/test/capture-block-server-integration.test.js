"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const {
  MAX_LITERAL_BYTES,
  captureBlockId,
} = require("../lib/capture-blocks");

const GATEWAY_TOKEN = "capture-server-integration-token";

test("server projects completed and reconciled dictation without truncation or execution", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-capture-server-"));
  const dataDir = path.join(root, "data");
  const modelTrap = http.createServer((_request, response) => {
    modelTrap.requestCount += 1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"error":"model must not run for dictation capture"}');
  });
  modelTrap.requestCount = 0;
  modelTrap.listen(0, "127.0.0.1");
  await once(modelTrap, "listening");

  const previousEnv = saveEnvironment([
    "DATA_DIR",
    "GATEWAY_TOKEN",
    "HOST",
    "MOA_MODE",
    "MODEL_BASE_URL",
    "MODEL_PROVIDER",
    "PORT",
  ]);
  const serverPath = require.resolve("../server");
  let gatewayServer;

  try {
    process.env.DATA_DIR = dataDir;
    process.env.GATEWAY_TOKEN = GATEWAY_TOKEN;
    process.env.HOST = "127.0.0.1";
    process.env.MOA_MODE = "local";
    process.env.MODEL_BASE_URL = `http://127.0.0.1:${modelTrap.address().port}/v1`;
    process.env.MODEL_PROVIDER = "openai";
    process.env.PORT = "0";

    const reconciled = completedDictationRecord({
      id: "turn_reconciled",
      session_id: "session_reconciled",
      conversation_id: "session_reconciled",
      transcript: "reconciled literal ".repeat(2048),
      created_at: "2026-07-23T01:00:00.000Z",
      updated_at: "2026-07-23T01:00:05.000Z",
    });
    seedVoiceTurn(dataDir, reconciled);

    delete require.cache[serverPath];
    const {
      server,
      startServer,
      recordStreamingVoiceTurn,
    } = require(serverPath);
    gatewayServer = server;
    startServer();
    await once(server, "listening");
    const port = server.address().port;

    const reconciledBlock = await waitForCaptureBlock(
      port,
      captureBlockId(reconciled.session_id, reconciled.id),
    );
    assert.equal(reconciledBlock.literal_transcript, reconciled.transcript);
    assertNonExecutingProjection(reconciledBlock);

    const exactBoundedLiteral = "x".repeat(MAX_LITERAL_BYTES);
    const completed = await recordStreamingVoiceTurn({
      session_id: "session_completed",
      conversation_id: "session_completed",
      branch_id: "default",
      turn_id: "turn_completed",
      device_id: "browser-dictation",
      source: "browser-extension",
      transcript: exactBoundedLiteral,
      transcript_source: "stt",
      // A stale/upstream reply must be discarded at the canonical persistence
      // boundary for an explicitly transcription-only turn.
      assistant_text: "must not persist",
      provider: "cascaded",
      model: "chirp_3",
      input_languages: ["en-US", "am-ET"],
      transcription_only: true,
      incomplete: false,
      status: "completed",
      started_at: "2026-07-23T02:00:00.000Z",
      completed_at: "2026-07-23T02:00:05.000Z",
      audio: {
        bytes: 32000,
        chunks: 4,
        encoding: "pcm16",
      },
    });

    assert.equal(completed.transcript.length, MAX_LITERAL_BYTES);
    assert.equal(completed.response.speak, "");
    assert.equal(completed.response.display, "");
    assert.equal(completed.response.text, "");
    assert.deepEqual(completed.response.agent_runs, []);
    assert.equal(completed.response.agent_run, null);
    assert.deepEqual(completed.transcript_completeness, {
      state: "complete",
      exact: true,
      truncated: false,
      source_utf8_bytes: MAX_LITERAL_BYTES,
      retained_utf8_bytes: MAX_LITERAL_BYTES,
    });
    assert.deepEqual(completed.response.actions, []);

    const completedBlock = await waitForCaptureBlock(
      port,
      captureBlockId(completed.session_id, completed.id),
    );
    assert.equal(completedBlock.literal_transcript.length, MAX_LITERAL_BYTES);
    assert.equal(completedBlock.literal_transcript, exactBoundedLiteral);
    assert.equal(completedBlock.transcript_completeness.state, "complete");
    assert.equal(completedBlock.transcript_completeness.exact, true);
    assert.equal(completedBlock.transcript_completeness.truncated, false);
    assert.equal(completedBlock.transcript_completeness.utf8_bytes, MAX_LITERAL_BYTES);
    assert.equal(completedBlock.transcript_completeness.source_utf8_bytes, MAX_LITERAL_BYTES);
    assert.equal(completedBlock.transcript_completeness.retained_utf8_bytes, MAX_LITERAL_BYTES);
    assert.deepEqual(
      completedBlock.transcript_provenance.input_languages,
      ["en-US", "am-ET"],
      "capture provenance must preserve configured prompt languages",
    );
    assertNonExecutingProjection(completedBlock);

    assert.equal(modelTrap.requestCount, 0);
    assert.equal(
      fs.existsSync(path.join(dataDir, "conversations", "session_completed.json")),
      false,
      "dictation persistence must not create an assistant conversation",
    );
    assert.equal(
      fs.existsSync(path.join(dataDir, "turns.jsonl")),
      false,
      "dictation persistence must not append a generated assistant turn",
    );
    assert.deepEqual(fs.readdirSync(path.join(dataDir, "agent-runs")), []);
  } finally {
    if (gatewayServer?.listening) {
      await new Promise((resolve) => gatewayServer.close(resolve));
    }
    await new Promise((resolve) => modelTrap.close(resolve));
    delete require.cache[serverPath];
    restoreEnvironment(previousEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function completedDictationRecord(overrides = {}) {
  const record = {
    id: "turn_seed",
    session_id: "session_seed",
    conversation_id: "session_seed",
    branch_id: "default",
    profile_version: "profile-test",
    device_id: "browser-dictation",
    source: "browser-extension",
    transcript: "literal seed",
    transcript_source: "stt",
    transcript_completeness: {
      state: "complete",
      exact: true,
      truncated: false,
      source_utf8_bytes: 12,
      retained_utf8_bytes: 12,
    },
    classification: "chat",
    screen: null,
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:05.000Z",
    response: {
      speak: "",
      display: "literal seed",
      actions: [],
      follow_up_expected: false,
    },
    references: {
      voice_session: {
        provider: "cascaded",
        model: "chirp_3",
        input_languages: ["en-US", "am-ET"],
        transcription_only: true,
        incomplete: false,
        status: "completed",
        audio: {
          bytes: 32000,
          chunks: 4,
          encoding: "pcm16",
        },
      },
    },
  };
  const merged = { ...record, ...overrides };
  const byteLength = Buffer.byteLength(merged.transcript, "utf8");
  merged.transcript_completeness = {
    state: "complete",
    exact: true,
    truncated: false,
    source_utf8_bytes: byteLength,
    retained_utf8_bytes: byteLength,
  };
  return merged;
}

function seedVoiceTurn(dataDir, record) {
  const turnDir = path.join(dataDir, "voice-turns", record.session_id);
  const audioDir = path.join(dataDir, "voice-sessions", record.session_id);
  fs.mkdirSync(turnDir, { recursive: true });
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(path.join(turnDir, `${record.id}.json`), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join(audioDir, `${record.id}.pcm`), Buffer.alloc(32));
}

function waitForCaptureBlock(port, id, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      requestJson(port, `/v1/capture-blocks/${id}`).then((result) => {
        if (result.status === 200) {
          resolve(result.json.capture_block);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`capture block ${id} was not projected: ${result.status}`));
          return;
        }
        setTimeout(attempt, 20);
      }, reject);
    };
    attempt();
  });
}

function requestJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: pathname,
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          json: body ? JSON.parse(body) : null,
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function assertNonExecutingProjection(block) {
  assert.equal(block.routing_proposals.length, 1);
  assert.equal(block.routing_proposals[0].route, "file_only");
  assert.equal(block.routing_proposals[0].classification, "unclassified");
  assert.equal(block.routing_proposals[0].executable, false);
  assert.equal(block.routing_proposals[0].provenance.model_used, false);
  assert.equal("agent_run_id" in block.routing_proposals[0], false);
  assert.equal("run_id" in block.routing_proposals[0], false);
}

function saveEnvironment(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
