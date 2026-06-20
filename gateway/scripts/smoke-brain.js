#!/usr/bin/env node
"use strict";

// Smoke for "the Brain" — the gateway's fail-soft MEMORY layer over the gbrain
// CLI. Proves the whole loop against a THROWAWAY brain that is never the real
// ~/.gbrain:
//
//   ISOLATION: a fresh GBRAIN_HOME tempdir is created and `gbrain init --pglite
//   --no-embedding` runs against it. We ASSERT the path is not ~/.gbrain before
//   writing anything, and STOP if gbrain is absent (we never risk the real
//   brain by falling through to a default location).
//
//   1. remember "my name is Bob" via the deterministic matcher + brain client;
//      recall returns it.
//   2. Run a real chat turn (model unconfigured -> fallback) and assert the
//      model-context that WOULD be sent (recorded in turns.jsonl request_messages)
//      contains "Bob" — i.e. the Steward injected the recalled memory.
//   3. remember a persona pref ("talk to me like a baller") and assert it is
//      recalled + injected into the next turn's model-context.
//   4. Write a fake "task done" memory and assert it is recallable.
//
// The gateway boots with a secret-free env, an empty MODEL_API_KEY (so no
// network call is made — the fallback reply path runs), and GBRAIN_HOME pointed
// at the isolated brain. The real .env is never loaded.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "brain-smoke-token";
const GBRAIN_BIN = process.env.GBRAIN_BIN || "gbrain";

const { createBrain } = require(path.join(GATEWAY_DIR, "lib", "brain"));
const { matchMemoryStatement } = require(path.join(GATEWAY_DIR, "lib", "memory-matcher"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  // --- Isolation: throwaway GBRAIN_HOME, asserted NOT to be the real brain ---
  const realBrain = path.resolve(os.homedir(), ".gbrain");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-brain-smoke-"));
  const gbrainHome = path.join(tempDir, "gbrain-home");
  fs.mkdirSync(gbrainHome, { recursive: true });
  assert.notStrictEqual(path.resolve(gbrainHome), realBrain, "isolated brain must not be the real ~/.gbrain");
  assert.ok(!path.resolve(gbrainHome).startsWith(realBrain + path.sep), "isolated brain must live outside ~/.gbrain");

  if (!gbrainAvailable()) {
    // Refuse to run against a default brain location — that would risk ~/.gbrain.
    console.error(JSON.stringify({
      ok: false,
      blocked: true,
      reason: "gbrain CLI not found on PATH; cannot isolate a throwaway brain. Refusing to run to avoid touching the real ~/.gbrain.",
      gbrain_bin: GBRAIN_BIN,
    }, null, 2));
    process.exitCode = 1;
    fs.rmSync(tempDir, { recursive: true, force: true });
    return;
  }

  initIsolatedBrain(gbrainHome);

  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    // In-process brain client pointed at the isolated home.
    const brain = createBrain({ gbrainHome, recallLimit: 5, log: () => {} });
    assert.equal(path.resolve(brain.gbrainHome), path.resolve(gbrainHome), "brain client must target the isolated home");

    await step("matcher detects identity statement", () => {
      const match = matchMemoryStatement("my name is Bob");
      assert.ok(match, "matcher must detect 'my name is Bob'");
      assert.equal(match.kind, "identity");
      assert.match(match.fact, /Bob/, "stored fact must mention Bob");
    });

    await step("remember -> recall round-trips the name (standing fact)", () => {
      const match = matchMemoryStatement("my name is Bob");
      // Seed the way the gateway's voice capture does: fact-as-title, tagged
      // "standing" so the standing-facts recall path surfaces it on every turn.
      assert.equal(
        brain.remember(match.fact, { kind: match.kind, tags: ["memory", "standing", match.kind], title: match.fact }),
        true,
        "remember must succeed",
      );
      const standing = brain.recallStandingFacts(5);
      assert.ok(standing.length > 0, "recallStandingFacts must return at least one memory");
      assert.ok(standing.some((m) => /Bob/.test(m.snippet)), `standing facts must surface Bob, got ${JSON.stringify(standing)}`);
    });

    await step("matcher detects persona preference (standing fact)", () => {
      const match = matchMemoryStatement("talk to me like a baller");
      assert.ok(match, "matcher must detect persona request");
      assert.equal(match.kind, "persona");
      assert.match(match.fact, /baller/, "persona fact must keep the user's phrasing");
      assert.equal(
        brain.remember(match.fact, { kind: match.kind, tags: ["memory", "standing", match.kind], title: match.fact }),
        true,
        "persona remember must succeed",
      );
      const standing = brain.recallStandingFacts(5);
      assert.ok(standing.some((m) => /baller/.test(m.snippet)), `persona must be recallable as a standing fact, got ${JSON.stringify(standing)}`);
    });

    await step("work-done memory is recallable", () => {
      assert.equal(
        brain.rememberWorkDone("Task run_smoke (echo) completed. Request: add a hello endpoint. Outcome: added /hello returning 200.", { slug: "moa/memory/work/run_smoke" }),
        true,
        "work-done memory must write",
      );
      const recalled = brain.recall("what task added the hello endpoint", 5);
      assert.ok(recalled.some((m) => /hello endpoint|run_smoke/.test(m.snippet)), `work memory must be recallable, got ${JSON.stringify(recalled)}`);
    });

    // --- End-to-end: the Steward injects recalled memory into the model context ---
    const started = await startGateway({ port, dataDir, gbrainHome });
    server = started.server;
    const gatewayLogs = started.logs;

    await step("chat turn injects recalled name into the model-context", async () => {
      await postChat(baseUrl, "what should you call me?");
      const messages = lastRequestMessages(dataDir);
      const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      assert.match(systemText, /Bob/, `model-context must contain the recalled name Bob; system context was:\n${systemText}\n--- gateway log ---\n${gatewayLogs.text()}`);
    });

    await step("voice turn injects recalled persona into the model-context", async () => {
      await postVoiceTurn(baseUrl, "how do you sound?");
      const messages = lastRequestMessages(dataDir);
      const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      assert.match(systemText, /baller/, `voice model-context must contain the recalled persona 'baller'; system context was:\n${systemText}`);
    });

    await step("voice turn 'call me Alice' captures a new memory, recalled next turn", async () => {
      // The gateway owns the PGLite lock while running, so we assert capture +
      // recall THROUGH the gateway: speak "call me Alice", then a follow-up turn
      // must carry "Alice" in the recalled model-context (the Steward now knows it).
      await postVoiceTurn(baseUrl, "call me Alice");
      await postChat(baseUrl, "say hi");
      const messages = lastRequestMessages(dataDir);
      const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      assert.match(systemText, /Alice/, `captured 'Alice' must be recalled into the next turn's model-context; system context was:\n${systemText}\n--- gateway log ---\n${gatewayLogs.text()}`);
    });

    await step("health reports the brain as available + isolated", async () => {
      const health = await fetch(`${baseUrl}/health`).then((r) => r.json());
      assert.ok(health.brain, "health must expose brain status");
      assert.equal(health.brain.available, true, "brain must report available with gbrain installed");
      assert.equal(path.resolve(health.brain.gbrain_home), path.resolve(gbrainHome), "health must report the isolated brain home");
    });

    console.log(JSON.stringify({
      ok: true,
      isolation: {
        mechanism: "GBRAIN_HOME env var points gbrain at a throwaway tempdir",
        gbrain_home: gbrainHome,
        real_brain_untouched: realBrain,
      },
      checks: [
        "matcher detects 'my name is Bob' (identity) and 'talk to me like a baller' (persona)",
        "remember -> recall round-trips the name Bob against the isolated brain",
        "chat turn: recalled memory 'Bob' is injected into the model-context (turns.jsonl request_messages)",
        "voice turn: recalled persona 'baller' is injected into the model-context",
        "voice turn 'call me Alice' captures a new memory deterministically",
        "work-done memory is written and recallable",
        "health reports brain.available=true with the isolated gbrain_home",
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

function gbrainAvailable() {
  try {
    const result = spawnSync(GBRAIN_BIN, ["--help"], { encoding: "utf8", timeout: 15000 });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function initIsolatedBrain(gbrainHome) {
  const result = spawnSync(GBRAIN_BIN, ["init", "--pglite", "--no-embedding"], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, GBRAIN_HOME: gbrainHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`gbrain init failed for isolated brain: ${result.error?.message || result.stderr || result.stdout}`);
  }
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

async function postChat(baseUrl, text) {
  const response = await fetch(`${baseUrl}/v1/chat`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: text }], source: "brain-smoke" }),
  });
  assert.ok(response.ok, `chat turn must succeed, got ${response.status}`);
  return response.json();
}

async function postVoiceTurn(baseUrl, transcript) {
  const response = await fetch(`${baseUrl}/v1/voice/turns`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ transcript, source: "brain-smoke" }),
  });
  assert.ok(response.ok, `voice turn must succeed, got ${response.status}`);
  return response.json();
}

// Read the most recent recorded turn's request_messages — the exact model-context
// the gateway WOULD send to the model.
function lastRequestMessages(dataDir) {
  const file = path.join(dataDir, "turns.jsonl");
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length > 0, "turns.jsonl must have at least one turn");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.ok(Array.isArray(last.request_messages), "turn must record request_messages");
  return last.request_messages;
}

async function startGateway({ port, dataDir, gbrainHome }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv({ port, dataDir, gbrainHome }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return { server, logs };
}

function gatewayEnv({ port, dataDir, gbrainHome }) {
  // Secret-free env. MODEL_API_KEY empty -> the fallback reply path runs, so no
  // network call. GBRAIN_HOME isolates the brain. PATH carries through so the
  // gateway can find the gbrain binary.
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
    MOA_GATEWAY_TOKEN: TOKEN,
    MODEL_PROVIDER: "openai-compatible",
    MODEL_ID: "brain-smoke-model",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    GBRAIN_HOME: gbrainHome,
  };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (error) {
      // Server may still be starting.
    }
    if (logs.exited) {
      throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}` };
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

function collectLogs(child) {
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (output.length > 12000) output = output.slice(-12000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", () => {
    logs.exited = true;
  });
  const logs = {
    exited: false,
    text: () => output,
  };
  return logs;
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
