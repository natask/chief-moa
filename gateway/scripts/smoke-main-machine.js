#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { WebSocket } = require("ws");

const baseUrl = stripTrailingSlash(process.argv[2] || process.env.MOA_GATEWAY_URL || process.env.MOA_MAIN_MACHINE_URL || "http://10.147.17.10:8787");
const token = process.argv[3] || process.env.MOA_GATEWAY_TOKEN || "";
const voiceUrl = process.env.MOA_GATEWAY_WS_URL || process.env.MOA_MAIN_MACHINE_WS_URL || baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/v1/voice/sessions";
const expectedVoiceModel = process.env.MOA_EXPECT_VOICE_MODEL || process.env.MOA_MAIN_MACHINE_EXPECT_VOICE_MODEL || "";

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    target: baseUrl,
    error: cleanError(error),
  }, null, 2));
  process.exitCode = 1;
});

async function main() {
  if (!token) {
    throw new Error("MOA_GATEWAY_TOKEN is required for protected gateway smoke checks");
  }

  const health = await getJson(`${baseUrl}/health`, false);
  assert(health.ok === true, "health did not return ok=true");
  assert(health.android_ota?.configured === true, "health did not report configured Android OTA");
  assert(health.voice_stream?.provider?.configured === true, "health did not report configured streaming voice provider");
  if (expectedVoiceModel) {
    assert(health.voice_stream?.provider?.model === expectedVoiceModel, `gateway voice model is not ${expectedVoiceModel}`);
  }

  const manifest = await getJson(`${baseUrl}/v1/android/updates/latest`, true);
  assert(manifest.app_id === "ai.moa.assistant", "OTA manifest app_id mismatch");
  assert(Number(manifest.version_code) > 0, "OTA manifest version_code missing");
  assert(manifest.sha256, "OTA manifest sha256 missing");
  assert(Number(manifest.size_bytes) > 0, "OTA manifest size_bytes missing");
  if (baseUrl.startsWith("https://")) {
    assert(String(manifest.download_url || "").startsWith(`${baseUrl}/`), "OTA manifest download_url is not using the HTTPS gateway origin");
  }

  const apk = Buffer.from(await getArrayBuffer(`${baseUrl}/v1/android/updates/latest.apk`));
  assert(apk.length === Number(manifest.size_bytes), `APK size mismatch: got ${apk.length}, expected ${manifest.size_bytes}`);
  const actualSha = crypto.createHash("sha256").update(apk).digest("hex");
  assert(actualSha === String(manifest.sha256).toLowerCase(), "APK sha256 mismatch");

  const operational_route = await smokeOperationalVoiceTurn();
  const voice = await smokeVoiceSession(voiceUrl, token);

  console.log(JSON.stringify({
    ok: true,
    base_url: baseUrl,
    voice_url: voiceUrl,
    ota: {
      version_code: manifest.version_code,
      version_name: manifest.version_name,
      size_bytes: manifest.size_bytes,
      sha256: manifest.sha256,
    },
    operational_route,
    voice,
  }, null, 2));
}

async function getJson(url, auth) {
  const response = await fetch(url, {
    headers: auth ? authHeaders() : {},
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text || "{}");
  } catch (error) {
    throw new Error(`${url} returned non-JSON: ${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function getArrayBuffer(url) {
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  return response.arrayBuffer();
}

async function postJson(url, body, auth = true) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...(auth ? authHeaders() : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text || "{}");
  } catch (error) {
    throw new Error(`${url} returned non-JSON: ${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function smokeOperationalVoiceTurn() {
  const sessionId = `operational_smoke_${Date.now()}`;
  const turnId = `turn_${Date.now()}`;
  const transcript = "what is going on with the Chrome extension, Android app, and mobile gateway?";
  const turn = await postJson(`${baseUrl}/v1/voice/turns`, {
    conversation_id: sessionId,
    session_id: sessionId,
    branch_id: "default",
    turn_id: turnId,
    source: "gateway-operational-smoke",
    harness: "echo",
    transcript,
  });

  assert(turn.classification === "chat", `operational phrase classified as ${turn.classification}`);
  assert(String(turn.display || "").includes("Operational snapshot:"), "operational turn did not include status snapshot");
  assert(String(turn.display || "").includes("Android OTA:"), "operational snapshot did not include Android OTA status");
  assert(String(turn.display || "").includes("Harnesses:"), "operational snapshot did not include harness status");
  const action = Array.isArray(turn.actions)
    ? turn.actions.find((candidate) => candidate?.type === "open_agent_run")
    : null;
  assert(!action, "operational status turn should not launch an agent run");

  return {
    transcript,
    classification: turn.classification,
    display_preview: String(turn.display || "").slice(0, 240),
    run_id: "",
    harness: "",
    status: "not_launched",
    events: [],
  };
}

async function pollAgentRun(runId) {
  let last;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    last = await getJson(`${baseUrl}/v1/agent/runs/${encodeURIComponent(runId)}`, true);
    const status = last.run?.status || "";
    if (["completed", "failed", "timed-out", "canceled"].includes(status)) {
      return last;
    }
    await delay(500);
  }
  throw new Error(`agent run ${runId} did not finish; last=${JSON.stringify(last?.run || last)}`);
}

function smokeVoiceSession(target, gatewayToken) {
  const sessionId = `smoke_${Date.now()}`;
  const turnId = `turn_${Date.now()}`;
  const speech = generateVoiceSmokePcm16();
  const required = new Set(["session_ready", "transcript_final", "assistant_audio_start", "assistant_audio_done", "turn_done"]);
  const seen = new Set();
  let audioBytes = 0;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target, {
      headers: { Authorization: `Bearer ${gatewayToken}` },
    });
    let sentAudio = false;
    const timeout = setTimeout(() => {
      closeQuietly(ws);
      reject(new Error(`timed out waiting for ${target}`));
    }, 30000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session_start",
        session_id: sessionId,
        turn_id: turnId,
        source: "gateway-smoke",
        format: {
          encoding: "pcm16",
          sample_rate: 16000,
          channels: 1,
        },
      }));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        audioBytes += Buffer.byteLength(data);
        return;
      }

      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      if (event.type === "error") {
        clearTimeout(timeout);
        closeQuietly(ws);
        reject(new Error(event.message || "gateway returned voice error"));
        return;
      }

      seen.add(event.type);
      if (event.type === "session_ready" && !sentAudio) {
        sentAudio = true;
        sendChunkedAudio(ws, speech.audio, turnId).catch((error) => {
          clearTimeout(timeout);
          closeQuietly(ws);
          reject(error);
        });
      }
      if (event.type === "turn_done") {
        const missing = [...required].filter((name) => !seen.has(name));
        clearTimeout(timeout);
        closeQuietly(ws);
        if (missing.length) {
          reject(new Error(`voice smoke missing events: ${missing.join(", ")}`));
          return;
        }
        if (audioBytes <= 0) {
          reject(new Error("voice smoke assistant audio stream was empty"));
          return;
        }
        resolve({
          session_id: sessionId,
          turn_id: turnId,
          input_audio_source: speech.source,
          events: [...seen],
          assistant_audio_bytes: audioBytes,
        });
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    ws.on("close", () => {
      if (!seen.has("turn_done")) {
        clearTimeout(timeout);
        reject(new Error("websocket closed before turn_done"));
      }
    });
  });
}

async function sendChunkedAudio(ws, audio, turnId) {
  const chunkBytes = Math.max(640, Number(process.env.MOA_GATEWAY_VOICE_CHUNK_BYTES || process.env.MOA_MAIN_MACHINE_VOICE_CHUNK_BYTES || 3200));
  const delayMs = Math.max(0, Number(process.env.MOA_GATEWAY_VOICE_CHUNK_DELAY_MS || process.env.MOA_MAIN_MACHINE_VOICE_CHUNK_DELAY_MS || 20));
  for (let offset = 0; offset < audio.length; offset += chunkBytes) {
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error("websocket closed while streaming voice smoke audio");
    }
    ws.send(audio.subarray(offset, Math.min(offset + chunkBytes, audio.length)));
    if (delayMs > 0) {
      await delay(delayMs);
    }
  }
  ws.send(JSON.stringify({
    type: "commit_turn",
    turn_id: turnId,
  }));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

function generateVoiceSmokePcm16() {
  const fixturePath = process.env.MOA_GATEWAY_VOICE_PCM || process.env.MOA_MAIN_MACHINE_VOICE_PCM || "";
  if (fixturePath) {
    return {
      source: fixturePath,
      audio: fs.readFileSync(fixturePath),
    };
  }

  const phrase = process.env.MOA_GATEWAY_VOICE_PHRASE || process.env.MOA_MAIN_MACHINE_VOICE_PHRASE || "Can you hear me clearly? This is an A.G. gateway smoke test.";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-smoke-"));
  const aiffPath = path.join(tempDir, "speech.aiff");
  const pcmPath = path.join(tempDir, "speech.pcm");
  try {
    execFileSync("say", ["-v", process.env.MOA_GATEWAY_SAY_VOICE || process.env.MOA_MAIN_MACHINE_SAY_VOICE || "Samantha", "-r", process.env.MOA_GATEWAY_SAY_RATE || process.env.MOA_MAIN_MACHINE_SAY_RATE || "135", "-o", aiffPath, phrase], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 10000,
    });
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", aiffPath, "-ac", "1", "-ar", "16000", "-f", "s16le", pcmPath], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 10000,
    });
    return {
      source: "macos-say-ffmpeg",
      audio: fs.readFileSync(pcmPath),
    };
  } catch {
    return {
      source: "fallback-tone",
      audio: generatePcm16Tone(16000, 220, 0.2, 1200),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function generatePcm16Tone(sampleRate, frequencyHz, volume, durationMs) {
  const sampleCount = Math.floor(sampleRate * durationMs / 1000);
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * frequencyHz * index / sampleRate) * volume * 32767);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index * 2);
  }
  return buffer;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function closeQuietly(ws) {
  try {
    ws.close(1000, "smoke complete");
  } catch (error) {
    // Ignore close failures during smoke cleanup.
  }
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}
