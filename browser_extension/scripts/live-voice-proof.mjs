// One-command live proof for a real browser voice turn against the current
// gateway (intent in-rgh.1). Orchestrates, in order:
//
//   1. GET /health                       -> runtime voice provider selection
//   2. English browser turn              -> real extension in headless Chrome
//      (smoke-live-voice-main.mjs)          for Testing: audio upload, STT,
//                                           reasoning text, returned TTS PCM,
//                                           playback scheduling, turn_done
//   3. Amharic browser turn              -> same path; speech PCM is rendered
//                                           by the gateway's own hosted TTS
//                                           (POST /v1/internal/voice/synthesize,
//                                           language am-ET) because macOS `say`
//                                           has no Amharic voice. Skipped with
//                                           a recorded reason if synthesis is
//                                           unavailable (e.g. content-policy).
//   4. GET /v1/sessions/default +        -> stored provider/transcript/language
//      GET /v1/voice/turns                  evidence correlated by the smoke's
//                                           printed turn ids
//
// Writes a JSON evidence file (default under the repo's scratch run dir) and
// prints a summary. The gateway token is read from AGEE_GATEWAY_TOKEN or the
// baked extension/agee.config.json and is never printed or written to evidence.
//
// Usage: node scripts/live-voice-proof.mjs [--out <evidence.json>]

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const repoRoot = resolve(root, "..");

function bakedConfig() {
  try {
    return JSON.parse(readFileSync(join(root, "extension", "agee.config.json"), "utf8"));
  } catch {
    return {};
  }
}

const baked = bakedConfig();
const GATEWAY_URL = String(process.env.AGEE_GATEWAY_URL || baked.gatewayUrl || "").replace(/\/+$/, "");
const GATEWAY_TOKEN = String(process.env.AGEE_GATEWAY_TOKEN || baked.gatewayToken || "");
const AMHARIC_PHRASE = process.env.AGEE_LIVE_VOICE_AMHARIC_PHRASE
  || "ሰላም። ይህ የአጊ የብራውዘር ድምፅ ሙከራ ነው። እባክህ በአማርኛ መልስልኝ።";

const outArgIndex = process.argv.indexOf("--out");
const outPath = outArgIndex >= 0 && process.argv[outArgIndex + 1]
  ? resolve(process.argv[outArgIndex + 1])
  : join(repoRoot, "scratch", "agent-loop", "runs", "20260714-browser-voice-live-proof",
      `evidence-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

const evidence = {
  intent: "in-rgh.1",
  started_at: new Date().toISOString(),
  gateway_url: GATEWAY_URL,
  legs: {},
};

async function gatewayFetch(path, init = {}) {
  const headers = { authorization: `Bearer ${GATEWAY_TOKEN}`, ...(init.headers || {}) };
  return fetch(GATEWAY_URL + path, { ...init, headers, signal: AbortSignal.timeout(30000) });
}

function runSmoke(label, extraEnv = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(root, "scripts", "smoke-live-voice-main.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        AGEE_GATEWAY_URL: GATEWAY_URL,
        AGEE_GATEWAY_TOKEN: GATEWAY_TOKEN,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("close", (code) => {
      const passedLine = out.split("\n").find((line) => line.includes("smoke passed")) || "";
      const turnId = (passedLine.match(/turn=([a-z0-9_]+)/) || [])[1] || "";
      resolveRun({
        label,
        exit_code: code,
        passed: code === 0 && Boolean(passedLine),
        turn_id: turnId,
        stdout_tail: out.slice(-1500),
        stderr_tail: err.slice(-800),
      });
    });
  });
}

async function synthesizeAmharicPcm() {
  const resp = await gatewayFetch("/v1/internal/voice/synthesize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: AMHARIC_PHRASE, language: "am-ET" }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`synthesize am-ET failed: HTTP ${resp.status} ${body.slice(0, 300)}`);
  }
  const pcm = Buffer.from(await resp.arrayBuffer());
  if (!pcm.length) throw new Error("synthesize am-ET returned empty audio");
  return pcm;
}

async function readBackTurns(turnIds) {
  const readback = { session_id: "", turns: [] };
  try {
    const sessionResp = await gatewayFetch("/v1/sessions/default");
    const session = sessionResp.ok ? await sessionResp.json() : {};
    readback.session_id = String(session.session_id || "");
  } catch (e) {
    readback.session_error = String(e.message || e);
  }
  for (const turnId of turnIds.filter(Boolean)) {
    try {
      const resp = await gatewayFetch(`/v1/voice/turns/${encodeURIComponent(turnId)}`);
      const body = await resp.json().catch(() => ({}));
      readback.turns.push({ turn_id: turnId, http_status: resp.status, record: body });
    } catch (e) {
      readback.turns.push({ turn_id: turnId, error: String(e.message || e) });
    }
  }
  return readback;
}

async function main() {
  if (!GATEWAY_URL) throw new Error("no gateway URL: set AGEE_GATEWAY_URL or bake extension/agee.config.json");
  if (!GATEWAY_TOKEN) throw new Error("no gateway token: set AGEE_GATEWAY_TOKEN or bake extension/agee.config.json");

  console.log(`live-voice proof against ${GATEWAY_URL}`);

  // Leg 1: runtime provider selection.
  const healthResp = await gatewayFetch("/health");
  const health = await healthResp.json();
  evidence.legs.health = {
    http_status: healthResp.status,
    voice_stream: health.voice_stream || null,
    version: health.version || health.git || null,
  };
  console.log(`health: ${healthResp.status}, voice provider: ${JSON.stringify(health.voice_stream?.provider ?? health.voice_stream ?? null).slice(0, 200)}`);

  // Leg 2: English browser turn through the real extension.
  console.log("running English browser turn (real extension, headless Chrome for Testing)...");
  evidence.legs.english_turn = await runSmoke("english");
  console.log(`english turn: ${evidence.legs.english_turn.passed ? "PASSED" : "FAILED"} (turn=${evidence.legs.english_turn.turn_id || "?"})`);

  // Leg 3: Amharic browser turn; speech PCM comes from the gateway's own TTS.
  const tempDir = mkdtempSync(join(tmpdir(), "agee-amharic-"));
  try {
    console.log("synthesizing Amharic speech via gateway hosted TTS...");
    const pcm = await synthesizeAmharicPcm();
    const pcmPath = join(tempDir, "amharic.pcm");
    writeFileSync(pcmPath, pcm);
    console.log(`running Amharic browser turn (${pcm.length} bytes of am-ET PCM)...`);
    evidence.legs.amharic_turn = await runSmoke("amharic", { AGEE_LIVE_VOICE_PCM_FILE: pcmPath });
    console.log(`amharic turn: ${evidence.legs.amharic_turn.passed ? "PASSED" : "FAILED"} (turn=${evidence.legs.amharic_turn.turn_id || "?"})`);
  } catch (e) {
    evidence.legs.amharic_turn = { skipped: true, reason: String(e.message || e) };
    console.log(`amharic turn SKIPPED: ${evidence.legs.amharic_turn.reason}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  // Leg 4: stored provider/transcript evidence for both turns.
  evidence.legs.stored_readback = await readBackTurns([
    evidence.legs.english_turn?.turn_id,
    evidence.legs.amharic_turn?.turn_id,
  ]);

  evidence.finished_at = new Date().toISOString();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  console.log(`evidence written: ${outPath}`);

  const englishOk = Boolean(evidence.legs.english_turn?.passed);
  const storedOk = (evidence.legs.stored_readback.turns || []).some((t) => t.http_status === 200);
  if (!englishOk) {
    console.error("RESULT: live proof NOT established (English browser turn failed)");
    process.exit(1);
  }
  console.log(`RESULT: live browser voice turn PROVEN end to end${storedOk ? " with stored-turn readback" : " (stored readback incomplete — inspect evidence)"}`);
}

main().catch((error) => {
  evidence.fatal = String(error.message || error);
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  } catch {}
  console.error(evidence.fatal);
  process.exit(1);
});
