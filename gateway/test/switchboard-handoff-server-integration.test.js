"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const { captureBlockId } = require("../lib/capture-blocks");

const TOKEN = "switchboard-handoff-integration-token";

test("server wires explicit capture-block handoff without changing capture behavior", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-switchboard-handoff-"));
  const prior = saveEnvironment([
    "AGENT_SWITCHBOARD_BASE_URL", "AGENT_SWITCHBOARD_TIMEOUT_MS",
    "AGENT_SWITCHBOARD_TOKEN", "DATA_DIR", "GATEWAY_TOKEN", "HOST", "MOA_MODE",
    "MODEL_PROVIDER", "PORT",
  ]);
  const switchboard = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    switchboard.requests.push(envelope);
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ admission: {
      id: "ext_integration",
      contractVersion: 1,
      rawIntentId: "raw_integration",
      messageId: "msg_integration",
      sourceSystem: envelope.source_system,
      sourceRecordId: envelope.source_record_id,
      sourceRevision: envelope.source_revision,
      sourceHash: envelope.source_hash,
      exactText: envelope.exact_text,
      evidenceRefs: envelope.evidence_refs,
      contextRefs: envelope.context_refs,
      projectHint: envelope.project_hint,
      authority: envelope.authority,
      idempotencyKey: envelope.idempotency_key,
      state: "queued",
      compiledIntents: [],
    } }));
  });
  switchboard.requests = [];
  switchboard.listen(0, "127.0.0.1");
  await once(switchboard, "listening");

  const serverPath = require.resolve("../server");
  let gateway;
  try {
    process.env.AGENT_SWITCHBOARD_BASE_URL = `http://127.0.0.1:${switchboard.address().port}`;
    delete process.env.AGENT_SWITCHBOARD_TIMEOUT_MS;
    delete process.env.AGENT_SWITCHBOARD_TOKEN;
    process.env.DATA_DIR = path.join(root, "data");
    process.env.GATEWAY_TOKEN = TOKEN;
    process.env.HOST = "127.0.0.1";
    process.env.MOA_MODE = "local";
    process.env.MODEL_PROVIDER = "openai";
    process.env.PORT = "0";
    delete require.cache[serverPath];
    const runtime = require(serverPath);
    gateway = runtime.server;
    await runtime.startServer();

    const turn = await runtime.recordStreamingVoiceTurn({
      session_id: "session_handoff",
      conversation_id: "session_handoff",
      branch_id: "default",
      turn_id: "turn_handoff",
      source: "browser-extension",
      transcript: "Complete this exact captured request.",
      transcript_source: "stt",
      provider: "cascaded",
      model: "chirp_3",
      transcription_only: true,
      status: "completed",
      started_at: "2026-08-03T12:00:00.000Z",
      completed_at: "2026-08-03T12:00:01.000Z",
      audio: { bytes: 3200, chunks: 1, encoding: "pcm16" },
    });
    const id = captureBlockId(turn.session_id, turn.id);
    const endpoint = `/v1/capture-blocks/${encodeURIComponent(id)}/handoff`;

    let result = await gatewayRequest(gateway, endpoint, { confirmed: false, authority: "execute" });
    assert.equal(result.status, 400);
    assert.equal(switchboard.requests.length, 0);

    result = await gatewayRequest(gateway, endpoint, { confirmed: true, authority: "execute" });
    assert.equal(result.status, 202);
    assert.equal(result.body.handoff.switchboard.admission_id, "ext_integration");
    assert.equal(switchboard.requests.length, 1);

    const retry = await gatewayRequest(gateway, endpoint, { confirmed: true, authority: "execute" });
    assert.deepEqual(retry.body, result.body);
    assert.equal(switchboard.requests.length, 1);

    const receiptEvents = fs.readFileSync(path.join(process.env.DATA_DIR, "product-events.jsonl"), "utf8")
      .trim().split("\n").map(JSON.parse)
      .filter((event) => event.event_type === "capture.handoff.received");
    assert.equal(receiptEvents.length, 1);
    assert.equal("exact_text" in receiptEvents[0].payload, false);
    assert.equal(JSON.stringify(receiptEvents[0].payload).includes(turn.transcript), false);
    assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "agent-runs")), []);
  } finally {
    if (gateway?.listening) await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => switchboard.close(resolve));
    delete require.cache[serverPath];
    restoreEnvironment(prior);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function gatewayRequest(server, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function saveEnvironment(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
