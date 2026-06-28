#!/usr/bin/env node
"use strict";

// Smoke for the gateway message broker. It proves the broker stores messages,
// routes explicit continuation to an existing session, recommends research
// and QA workflow packages when requested, creates focused launcher context packs,
// attaches evidence to active runs without cancellation, and persists
// inspectable route decisions.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "message-broker-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-message-broker-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const fakeGemini = writeFakeHarness(tempDir, "fake-gemini.sh");
  const fakeGbrainStore = path.join(tempDir, "fake-gbrain-store.json");
  const fakeGbrain = writeFakeGbrain(tempDir, fakeGbrainStore);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir, fakeGemini, fakeGbrain, fakeGbrainStore });
    await step("broker auth required", () => assertAuthRequired(baseUrl));
    const sessionId = `broker_session_${Date.now().toString(36)}`;
    await step("seed existing session", () => seedVoiceTurn(baseUrl, sessionId));
    const activeRunId = await step("seed active run", () => seedActiveAgentRun(dataDir, sessionId));
    const continuation = await step("explicit session routes to continuation", () =>
      assertContinuationRoute(baseUrl, dataDir, sessionId));
    await step("research message selects workflow package and fork", () =>
      assertResearchRoute(baseUrl, dataDir));
    await step("QA message selects validation workflow", () =>
      assertQaRoute(baseUrl, dataDir));
    await step("broker attaches evidence to active run", () =>
      assertActiveRunAttachment(baseUrl, dataDir, activeRunId));
    await step("broker follow-up does not cancel active run", () =>
      assertRuntimeActiveRunFollowUp(baseUrl, dataDir, sessionId));
    await step("broker event persisted", () =>
      assertBrokerLedger(dataDir, continuation.event.id));
    await step("broker event appears in history search", () =>
      assertBrokerHistorySearch(baseUrl, continuation.event.id, sessionId));
    await step("broker event is semantically indexed in gbrain", () =>
      assertBrokerBrainIndex(fakeGbrainStore, continuation.event.id));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      session_id: sessionId,
      broker_event_id: continuation.event.id,
      checks: [
        "POST /v1/broker/messages requires a token",
        "broker stores a canonical message event",
        "explicit session_id returns a continue_session decision",
        "broker decisions create launcher context packs",
        "research/report message returns a landscape-research workflow decision",
        "test/verify message returns a QA workflow decision",
        "active run messages append broker_evidence_attached without cancellation",
        "a second user turn while an agent run is active leaves the run active",
        "new work message can recommend create_new_fork without cancellation",
        "broker ledger persists route reasons",
        "brokered intents appear in /v1/history/messages search",
        "brokered intents are indexed into gbrain as semantic summaries",
      ],
    }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function assertAuthRequired(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/broker/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  assert.equal(response.status, 401);
}

async function seedVoiceTurn(baseUrl, sessionId) {
  const response = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "message-broker-smoke",
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "default",
    transcript: "we are working on the browser extension broker routing",
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
}

function seedActiveAgentRun(dataDir, sessionId) {
  const now = new Date().toISOString();
  const runId = `run_broker_active_${Date.now().toString(36)}`;
  const runDir = path.join(dataDir, "agent-runs");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, `${runId}.json`), JSON.stringify({
    id: runId,
    status: "running",
    harness: "echo",
    prompt: "keep working on browser extension broker routing and session context",
    screen: null,
    source: "message-broker-smoke",
    conversation_id: sessionId,
    profile_version: "profile_smoke",
    parent_run_id: "",
    project_id: "",
    resume_session_id: "",
    session_id: "",
    working_dir: GATEWAY_DIR,
    timeout_ms: 600000,
    created_at: now,
    updated_at: now,
    started_at: now,
    finished_at: null,
    exit_code: null,
    signal: null,
    stdout: "",
    stderr: "",
    output: "",
    error: "",
  }, null, 2));
  fs.writeFileSync(path.join(runDir, `${runId}.events.jsonl`), JSON.stringify({
    id: "evt_seed",
    ts: now,
    type: "started",
    command: "seed",
    args: [],
    cwd: GATEWAY_DIR,
  }) + "\n");
  return runId;
}

async function assertContinuationRoute(baseUrl, dataDir, sessionId) {
  const response = await postJson(`${baseUrl}/v1/broker/messages`, {
    source: "message-broker-smoke",
    session_id: sessionId,
    text: "continue the browser extension broker routing session",
  });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  const route = response.json.decisions.find((decision) =>
    decision.target_type === "session" &&
    decision.target_id === sessionId &&
    decision.action === "continue_session");
  assert.ok(route, `expected continue_session route, got ${JSON.stringify(response.json.decisions)}`);
  assert.equal(route.cancellation_behavior, "none");
  assert.match(route.reason, /session_id|overlaps/);
  assert.ok(route.context_pack_id, "continue route must reference a context pack");
  const pack = readContextPack(dataDir, route.context_pack_id);
  assert.equal(pack.launcher_profile_id, "direct-answer");
  assert.equal(pack.workflow_directory, "gateway/agent-workflows/direct-answer");
  assert.equal(pack.instruction_file, "gateway/agent-workflows/direct-answer/WORKFLOW.md");
  assert.match(pack.inputs.session_context, /browser extension broker routing/);
  assert.ok(
    Array.isArray(response.json.context_packs) && response.json.context_packs.some((candidate) => candidate.id === route.context_pack_id),
    "broker response must include the generated context pack",
  );
  return response.json;
}

async function assertResearchRoute(baseUrl, dataDir) {
  const response = await postJson(`${baseUrl}/v1/broker/messages`, {
    source: "message-broker-smoke",
    text: "start a new research report and search online for the most optimal path",
  });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  assert.ok(
    response.json.decisions.some((decision) =>
      decision.target_type === "workflow" &&
      decision.target_id === "landscape-research" &&
      decision.action === "invoke_workflow"),
    `expected landscape-research workflow route, got ${JSON.stringify(response.json.decisions)}`,
  );
  const research = response.json.decisions.find((decision) => decision.target_id === "landscape-research");
  assert.equal(research.launcher_profile_id, "landscape-research");
  const pack = readContextPack(dataDir, research.context_pack_id);
  assert.equal(pack.workflow_directory, "gateway/agent-workflows/landscape-research");
  assert.equal(pack.instruction_file, "gateway/agent-workflows/landscape-research/WORKFLOW.md");
  assert.match(pack.launcher.prompt, /Workflow directory: gateway\/agent-workflows\/landscape-research/);
  assert.ok(
    response.json.decisions.some((decision) => decision.action === "create_new_fork"),
    `expected create_new_fork route, got ${JSON.stringify(response.json.decisions)}`,
  );
  assert.ok(response.json.decisions.every((decision) => decision.cancellation_behavior === "none"));
}

async function assertQaRoute(baseUrl, dataDir) {
  const response = await postJson(`${baseUrl}/v1/broker/messages`, {
    source: "message-broker-smoke",
    text: "verify this with smoke tests and validation before deploying",
  });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  const qa = response.json.decisions.find((decision) =>
    decision.target_type === "workflow" &&
    decision.target_id === "qa" &&
    decision.action === "invoke_workflow");
  assert.ok(qa, `expected QA workflow route, got ${JSON.stringify(response.json.decisions)}`);
  assert.equal(qa.launcher_profile_id, "qa");
  const pack = readContextPack(dataDir, qa.context_pack_id);
  assert.equal(pack.workflow_directory, "gateway/agent-workflows/qa");
  assert.equal(pack.instruction_file, "gateway/agent-workflows/qa/WORKFLOW.md");
  assert.ok(pack.verification.some((item) => item.includes("npm run check")), "QA pack must carry verification commands");
}

async function assertActiveRunAttachment(baseUrl, dataDir, activeRunId) {
  const response = await postJson(`${baseUrl}/v1/broker/messages`, {
    source: "message-broker-smoke",
    agent_run_id: activeRunId,
    text: "attach this follow-up to the running browser extension broker agent",
  });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  const route = response.json.decisions.find((decision) =>
    decision.target_type === "agent_run" &&
    decision.target_id === activeRunId &&
    decision.action === "attach_as_evidence");
  assert.ok(route, `expected active-run evidence route, got ${JSON.stringify(response.json.decisions)}`);
  assert.equal(route.cancellation_behavior, "none");
  assert.equal(route.launcher_profile_id, "coding");
  assert.equal(route.workflow_directory, "gateway/agent-workflows/coding");
  const pack = readContextPack(dataDir, route.context_pack_id);
  assert.equal(pack.instruction_file, "gateway/agent-workflows/coding/WORKFLOW.md");
  assert.equal(pack.inputs.target_run.id, activeRunId);

  const eventsPath = path.join(dataDir, "agent-runs", `${activeRunId}.events.jsonl`);
  const events = fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const attached = events.find((event) =>
    event.type === "broker_evidence_attached" &&
    event.broker_event_id === response.json.event.id);
  assert.ok(attached, "target run must receive broker_evidence_attached event");
  assert.equal(attached.context_pack_id, route.context_pack_id);
}

async function assertRuntimeActiveRunFollowUp(baseUrl, dataDir, sessionId) {
  const runResponse = await postJson(`${baseUrl}/v1/agent/runs`, {
    source: "message-broker-smoke",
    conversation_id: sessionId,
    harness: "gemini",
    wait: false,
    prompt: "SLEEP_BROKER keep working on canonical voice session transcript storage",
  });
  assert.equal(runResponse.status, 202, JSON.stringify(runResponse.json));
  const runId = runResponse.json.run.id;
  await waitForRunStatus(baseUrl, runId, "running");

  const response = await postJson(`${baseUrl}/v1/broker/messages`, {
    source: "message-broker-smoke",
    session_id: sessionId,
    agent_run_id: runId,
    transcript: "second turn: attach this evidence about transcript partials and finals to the active run",
    evidence_refs: [{ type: "voice_turn", session_id: sessionId, turn_id: "follow_up_turn" }],
  });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  const route = response.json.decisions.find((decision) =>
    decision.target_type === "agent_run" &&
    decision.target_id === runId &&
    decision.action === "attach_as_evidence");
  assert.ok(route, `expected active run evidence route, got ${JSON.stringify(response.json.decisions)}`);
  assert.equal(route.cancellation_behavior, "none");
  assert.match(route.reason, /agent_run_id/);
  assert.ok(route.context_pack_id, "active run evidence route must include a context pack");

  const after = await getJson(`${baseUrl}/v1/agent/runs/${runId}`);
  assert.equal(after.run.status, "running", "broker follow-up must not cancel or replace the active run");
  assert.equal(after.active, true, "run must remain active after broker follow-up");
  assert.ok(!after.events.some((event) => event.type === "cancel_requested"), "broker follow-up must not request cancellation");
  assert.ok(!after.events.some((event) => event.type === "canceled"), "broker follow-up must not cancel the active run");
  const attached = after.events.find((event) =>
    event.type === "broker_evidence_attached" &&
    event.broker_event_id === response.json.event.id);
  assert.ok(attached, "active run must receive broker_evidence_attached event");
  assert.equal(attached.reason, route.reason);
  assert.match(attached.text, /transcript partials and finals/);

  const eventPath = path.join(dataDir, "broker-events", `${response.json.event.id}.json`);
  const stored = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const storedRoute = stored.decisions.find((decision) => decision.id === route.id);
  assert.ok(storedRoute, "broker event must persist the route decision");
  assert.equal(storedRoute.reason, route.reason);
  assert.equal(storedRoute.cancellation_behavior, "none");
  assert.deepEqual(stored.evidence_refs, [{ type: "voice_turn", session_id: sessionId, turn_id: "follow_up_turn" }]);

  const terminal = await waitForRunTerminal(baseUrl, runId);
  assert.equal(terminal.run.status, "completed");
}

function assertBrokerLedger(dataDir, eventId) {
  const eventPath = path.join(dataDir, "broker-events", `${eventId}.json`);
  assert.ok(fs.existsSync(eventPath), "broker event JSON missing");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  assert.equal(event.id, eventId);
  assert.ok(Array.isArray(event.decisions) && event.decisions.length > 0, "broker event must store decisions");
  assert.ok(Array.isArray(event.context_pack_refs) && event.context_pack_refs.length > 0, "broker event must store context pack refs");

  const ledgerPath = path.join(dataDir, "broker-events.jsonl");
  const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
  assert.ok(lines.some((line) => JSON.parse(line).id === eventId), "broker ledger missing event id");
}

async function assertBrokerHistorySearch(baseUrl, eventId, sessionId) {
  const history = await getJson(`${baseUrl}/v1/history/messages?session_id=${encodeURIComponent(sessionId)}&q=continue`);
  const item = history.messages.find((message) => message.id === `broker:${eventId}`);
  assert.ok(item, `history search must include broker event ${eventId}`);
  assert.equal(item.type, "broker_event");
  assert.equal(item.classification, "intent");
  assert.ok(
    item.refs.decisions.some((decision) => decision.action === "continue_session"),
    "broker history item must include route decision summary",
  );
  assert.ok(
    history.semantic_memories.some((memory) => memory.slug.endsWith(`/intent/${eventId}`)),
    "history search must include the semantic gbrain intent hit",
  );
}

function assertBrokerBrainIndex(fakeGbrainStore, eventId) {
  const store = JSON.parse(fs.readFileSync(fakeGbrainStore, "utf8"));
  const slug = `moa/memory/intent/${eventId}`;
  assert.ok(store[slug], `fake gbrain store missing ${slug}`);
  assert.match(store[slug], new RegExp(`Intent ${eventId}`));
  assert.match(store[slug], /continue the browser extension broker routing session/);
  assert.match(store[slug], /Route decisions:/);
}

function readContextPack(dataDir, id) {
  assert.ok(id, "context pack id is required");
  const packPath = path.join(dataDir, "broker-context-packs", `${id}.json`);
  assert.ok(fs.existsSync(packPath), `context pack JSON missing: ${id}`);
  return JSON.parse(fs.readFileSync(packPath, "utf8"));
}

async function startGateway({ port, dataDir, fakeGemini, fakeGbrain, fakeGbrainStore }) {
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
      DEFAULT_AGENT_HARNESS: "gemini",
      GEMINI_BIN: fakeGemini,
      GBRAIN_BIN: fakeGbrain,
      GBRAIN_HOME: path.join(path.dirname(fakeGbrainStore), "gbrain-home"),
      FAKE_GBRAIN_STORE: fakeGbrainStore,
      AGENT_RUN_TIMEOUT_MS: "8000",
      MODEL_PROVIDER: "openai-compatible",
      MODEL_ID: "message-broker-smoke-model",
      MODEL_API_KEY: "",
      OPENAI_API_KEY: "",
      GOOGLE_API_KEY: "",
      GEMINI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

function writeFakeHarness(tempDir, fileName) {
  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, [
    "#!/usr/bin/env sh",
    "if [ \"$1\" = \"-v\" ] || [ \"$1\" = \"--version\" ]; then echo 'fake-gemini 0.0.0'; exit 0; fi",
    "case \"$*\" in *SLEEP_BROKER*) sleep 2; echo 'fake broker harness completed'; exit 0;; esac",
    "echo 'fake broker harness completed'",
  ].join("\n"));
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeFakeGbrain(tempDir, storePath) {
  const filePath = path.join(tempDir, "fake-gbrain.js");
  fs.writeFileSync(filePath, `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const storePath = process.env.FAKE_GBRAIN_STORE;
function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch {
    return {};
  }
}
function writeStore(store) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}
function titleOf(content) {
  const match = String(content || "").match(/^title:\\s*(.+)$/m);
  return match ? match[1].replace(/^"|"$/g, "") : String(content || "").split("\\n").find(Boolean) || "Memory";
}
function tokens(value) {
  return String(value || "").toLowerCase().split(/[^a-z0-9_-]+/).filter((token) => token.length >= 3);
}
const [cmd, ...args] = process.argv.slice(2);
if (cmd === "--help" || cmd === "help") {
  console.log("fake gbrain");
  process.exit(0);
}
if (!storePath) {
  console.error("FAKE_GBRAIN_STORE is required");
  process.exit(2);
}
if (cmd === "put") {
  const slug = args[0];
  const contentIndex = args.indexOf("--content");
  const content = contentIndex >= 0 ? args[contentIndex + 1] || "" : "";
  const store = readStore();
  store[slug] = content;
  writeStore(store);
  console.log(slug);
  process.exit(0);
}
if (cmd === "query") {
  const question = args[0] || "";
  const queryTokens = tokens(question);
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1] || 5) : 5;
  const store = readStore();
  let emitted = 0;
  for (const [slug, content] of Object.entries(store)) {
    const haystack = String(content).toLowerCase();
    if (queryTokens.length && !queryTokens.some((token) => haystack.includes(token))) continue;
    console.log("[0.9000] " + slug + " -- " + titleOf(content));
    emitted += 1;
    if (emitted >= limit) break;
  }
  process.exit(0);
}
if (cmd === "list") {
  const tagIndex = args.indexOf("--tag");
  const tag = tagIndex >= 0 ? args[tagIndex + 1] || "" : "";
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1] || 5) : 5;
  const store = readStore();
  let emitted = 0;
  for (const [slug, content] of Object.entries(store)) {
    if (tag && !String(content).includes("- " + tag)) continue;
    console.log(slug + "\\tnote\\t2026-06-28\\t" + titleOf(content));
    emitted += 1;
    if (emitted >= limit) break;
  }
  process.exit(0);
}
console.error("unsupported fake gbrain command: " + cmd);
process.exit(2);
`);
  fs.chmodSync(filePath, 0o755);
  fs.writeFileSync(storePath, "{}");
  return filePath;
}

async function waitForRunStatus(baseUrl, runId, status) {
  const deadline = Date.now() + 5000;
  let last;
  while (Date.now() < deadline) {
    last = await getJson(`${baseUrl}/v1/agent/runs/${runId}`);
    if (last.run.status === status) {
      return last;
    }
    await sleep(100);
  }
  throw new Error(`run ${runId} did not reach ${status}; last=${JSON.stringify(last)}`);
}

async function waitForRunTerminal(baseUrl, runId) {
  const terminal = new Set(["completed", "failed", "timed-out", "canceled"]);
  const deadline = Date.now() + 7000;
  let last;
  while (Date.now() < deadline) {
    last = await getJson(`${baseUrl}/v1/agent/runs/${runId}`);
    if (terminal.has(last.run.status)) {
      return last;
    }
    await sleep(100);
  }
  throw new Error(`run ${runId} did not finish; last=${JSON.stringify(last)}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function getJson(url) {
  const response = await fetch(url, { headers: authHeaders() });
  const json = await response.json();
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    if (logs.exited) throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

function collectLogs(child) {
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (output.length > 12000) output = output.slice(-12000);
  };
  const logs = { exited: false, text: () => output };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", () => {
    logs.exited = true;
  });
  return logs;
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => child.kill("SIGKILL")),
  ]);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
