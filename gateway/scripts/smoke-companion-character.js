#!/usr/bin/env node
"use strict";

// Integration smoke for the companion character + voice library gateway surface
// (companion-character-voice-library change), deterministic (no model, no live
// provider). Boots node server.js on a throwaway port + token + DATA_DIR (real
// .env never loaded) and drives the HTTP endpoints:
//
//   1. Manifest v2 round-trip: a v2 create (persona, voice_profile, provenance,
//      command_verbs) survives create -> list -> preview -> apply, and a v1
//      create (no v2 fields) still loads with safe defaults.
//   2. Voice-clone dry-run: POST /v1/agent/pets/:id/voice-clone with attested
//      consent stores a "blocked_allowlist" job, binds the closest canonical
//      voice as the fallback, and rejects missing consent / bad reference. GET
//      reads the job status.
//   3. Shared library: publish requires approved provenance (409 otherwise),
//      /shared lists published manifests, and install applies it as a profile
//      patch.
//
// The user's live gateway and gateway/data are never touched.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "companion-character-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-companion-character-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir });

    await step("manifest v2 round-trips through create/list/preview/apply", () => assertManifestV2RoundTrip(baseUrl));
    await step("v1 manifest (no v2 fields) loads with safe defaults", () => assertV1ManifestLoads(baseUrl));
    await step("voice-clone dry-run stores blocked_allowlist + canonical fallback", () => assertVoiceCloneDryRun(baseUrl));
    await step("voice-clone rejects missing consent and bad reference", () => assertVoiceCloneValidation(baseUrl));
    await step("shared library publish/list/install", () => assertSharedLibrary(baseUrl));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      checks: [
        "a v2 create (persona, voice_profile, provenance, command_verbs) survives create -> list -> preview -> apply",
        "a v1 create with no v2 fields loads with safe defaults (empty persona, canonical voice_profile, full command_verbs, local visibility)",
        "POST voice-clone with attested consent stores a blocked_allowlist dry-run job and binds the closest canonical voice as the fallback; GET reads job status",
        "voice-clone rejects consent.attested!=true (422) and a missing/non-https reference (422)",
        "publish requires provenance.consent_state=approved (409 otherwise), /shared lists it, and install applies it as a profile patch",
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

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

// --- Case 1: manifest v2 round-trip ---------------------------------------

async function assertManifestV2RoundTrip(baseUrl) {
  const created = await postJson(`${baseUrl}/v1/agent/pets`, {
    text: "be my calm study buddy",
    name: "Nova",
    persona: "You are Nova, a calm and patient study buddy.",
    voice_profile: { kind: "canonical", voice_id: "Aoede" },
    provenance: {
      character_name: "Nova",
      reference_media_urls: ["https://example.com/nova.png", "http://insecure.example/x.png"],
      license_note: "Original character, CC-BY.",
      consent_state: "unreviewed",
    },
    command_verbs: ["walk", "seek", "not-a-verb"],
  });
  assert.equal(created.status, 201, `create must succeed: ${JSON.stringify(created.json)}`);
  const companion = created.json.companion;
  assert.ok(companion && companion.id, "create must return a companion with an id");
  assert.equal(companion.persona, "You are Nova, a calm and patient study buddy.", "persona must survive create");
  assert.equal(companion.voice_profile.kind, "canonical", "voice_profile.kind must survive");
  assert.equal(companion.voice_profile.voice_id, "Aoede", "voice_profile.voice_id must survive");
  assert.deepEqual(companion.provenance.reference_media_urls, ["https://example.com/nova.png"], "non-https reference urls must be dropped");
  assert.equal(companion.provenance.consent_state, "unreviewed", "consent_state must survive");
  assert.deepEqual(companion.command_verbs, ["walk", "seek"], "unknown command verbs must be dropped");
  assert.equal(companion.manifest_version, "companion-manifest/v2", "manifest_version must be present");
  assert.equal(companion.visibility, "local", "default visibility must be local");

  const id = companion.id;

  // list
  const list = await getJson(`${baseUrl}/v1/agent/pets?q=Nova`);
  assert.equal(list.status, 200, "list must succeed");
  const listed = (list.json.companions || []).find((c) => c.id === id);
  assert.ok(listed, "created companion must appear in list");
  assert.equal(listed.persona, companion.persona, "persona must survive list");
  assert.deepEqual(listed.command_verbs, ["walk", "seek"], "command_verbs must survive list");

  // preview
  const preview = await postJson(`${baseUrl}/v1/agent/pets/preview`, { companion_id: id });
  assert.equal(preview.status, 200, "preview must succeed");
  assert.equal(preview.json.companion.persona, companion.persona, "persona must survive preview");
  assert.equal(preview.json.companion.provenance.character_name, "Nova", "provenance must survive preview");

  // apply
  const apply = await postJson(`${baseUrl}/v1/agent/pets/apply`, { companion_id: id });
  assert.equal(apply.status, 200, `apply must succeed: ${JSON.stringify(apply.json)}`);
  assert.equal(apply.json.active_companion?.id, id, "apply must set the active companion");
  assert.equal(apply.json.active_companion?.companion?.persona, companion.persona, "applied companion must round-trip persona");
}

// --- Case 2: v1 manifest still loads --------------------------------------

async function assertV1ManifestLoads(baseUrl) {
  const created = await postJson(`${baseUrl}/v1/agent/pets`, {
    text: "help me write emails",
    name: "Penn",
  });
  assert.equal(created.status, 201, "v1 create must succeed");
  const c = created.json.companion;
  assert.equal(c.persona, "", "absent persona defaults to empty");
  assert.equal(c.voice_profile.kind, "canonical", "absent voice_profile defaults to canonical");
  assert.ok(c.voice_profile.voice_id, "voice_profile.voice_id defaults to a catalog voice");
  assert.equal(c.provenance.consent_state, "unreviewed", "absent provenance defaults to unreviewed");
  assert.ok(Array.isArray(c.command_verbs) && c.command_verbs.length >= 5, "absent command_verbs defaults to the full allowlist");
  assert.equal(c.visibility, "local", "absent visibility defaults to local");
}

// --- Case 3: voice-clone dry-run ------------------------------------------

async function assertVoiceCloneDryRun(baseUrl) {
  const created = await postJson(`${baseUrl}/v1/agent/pets`, { text: "sound like my hero", name: "Echo" });
  const id = created.json.companion.id;
  const fallback = created.json.companion.voice_binding.provider_voice_id;

  const audioBase64 = Buffer.from("fake-wav-bytes-for-smoke").toString("base64");
  const clone = await postJson(`${baseUrl}/v1/agent/pets/${encodeURIComponent(id)}/voice-clone`, {
    reference_audio_base64: audioBase64,
    consent: { attested: true, subject: "the smoke operator" },
  });
  assert.equal(clone.status, 201, `voice-clone must succeed: ${JSON.stringify(clone.json)}`);
  assert.equal(clone.json.job.status, "blocked_allowlist", "dry-run job must be blocked_allowlist");
  assert.equal(clone.json.job.mode, "dry_run", "job mode must be dry_run");
  assert.equal(clone.json.job.reference.kind, "audio", "reference kind must be audio");
  assert.ok(clone.json.job.reference.audio_sha256, "reference must record a sha, not the bytes");
  assert.ok(!("audio_base64" in clone.json.job.reference), "raw audio must never be stored");
  assert.equal(clone.json.companion.voice_profile.kind, "custom", "voice_profile must flip to custom");
  assert.equal(clone.json.companion.voice_profile.custom_voice_ref, clone.json.job.id, "voice_profile must reference the job");
  assert.equal(clone.json.companion.voice_profile.voice_id, fallback, "the bound fallback must be the closest canonical voice");
  assert.equal(clone.json.companion.voice_binding.custom_voice.status, "blocked_allowlist", "custom_voice.status must reflect the block");

  const status = await getJson(`${baseUrl}/v1/agent/pets/${encodeURIComponent(id)}/voice-clone`);
  assert.equal(status.status, 200, "voice-clone GET must succeed");
  assert.equal(status.json.job.id, clone.json.job.id, "GET must return the latest job");
  assert.equal(status.json.voice_clone.status, "blocked_allowlist", "GET must surface the clone status");
}

async function assertVoiceCloneValidation(baseUrl) {
  const created = await postJson(`${baseUrl}/v1/agent/pets`, { text: "another voice", name: "Vox" });
  const id = created.json.companion.id;

  const noConsent = await postJson(`${baseUrl}/v1/agent/pets/${encodeURIComponent(id)}/voice-clone`, {
    reference_url: "https://example.com/ref.wav",
    consent: { attested: false, subject: "x" },
  });
  assert.equal(noConsent.status, 422, "missing attested consent must be 422");

  const badRef = await postJson(`${baseUrl}/v1/agent/pets/${encodeURIComponent(id)}/voice-clone`, {
    reference_url: "http://insecure.example/ref.wav",
    consent: { attested: true, subject: "x" },
  });
  assert.equal(badRef.status, 422, "non-https reference url must be 422");

  const noRef = await postJson(`${baseUrl}/v1/agent/pets/${encodeURIComponent(id)}/voice-clone`, {
    consent: { attested: true, subject: "x" },
  });
  assert.equal(noRef.status, 422, "missing reference must be 422");
}

// --- Case 4: shared library -----------------------------------------------

async function assertSharedLibrary(baseUrl) {
  // A companion that is not consent-approved cannot be published.
  const unreviewed = await postJson(`${baseUrl}/v1/agent/pets`, { text: "a shy pet", name: "Shy" });
  const unreviewedId = unreviewed.json.companion.id;
  const blocked = await postJson(`${baseUrl}/v1/agent/pets/${encodeURIComponent(unreviewedId)}/publish`, {});
  assert.equal(blocked.status, 409, "publishing an unreviewed companion must be 409");
  assert.equal(blocked.json.code, "consent_not_approved", "409 must carry a consent_not_approved code");
  assert.equal(blocked.json.reason, "unreviewed", "409 must carry the current consent state as reason");

  // An approved companion publishes, lists in /shared, and installs.
  const approved = await postJson(`${baseUrl}/v1/agent/pets`, {
    text: "a hero companion",
    name: "Ari",
    provenance: { character_name: "Ari", consent_state: "approved", license_note: "Original." },
  });
  const approvedId = approved.json.companion.id;
  const published = await postJson(`${baseUrl}/v1/agent/pets/${encodeURIComponent(approvedId)}/publish`, {});
  assert.equal(published.status, 200, `publishing an approved companion must succeed: ${JSON.stringify(published.json)}`);
  assert.equal(published.json.visibility, "shared", "published companion must be shared");

  const shared = await getJson(`${baseUrl}/v1/agent/pets/shared`);
  assert.equal(shared.status, 200, "shared list must succeed");
  const found = (shared.json.companions || []).find((c) => c.id === approvedId);
  assert.ok(found, "the published companion must appear in /shared");
  assert.ok(!(shared.json.companions || []).some((c) => c.id === unreviewedId), "an unpublished companion must not appear in /shared");

  const install = await postJson(`${baseUrl}/v1/agent/pets/install`, { id: approvedId });
  assert.equal(install.status, 200, `install must succeed: ${JSON.stringify(install.json)}`);
  assert.equal(install.json.installed_id, approvedId, "install must report the installed id");
  assert.equal(install.json.active_companion?.id, approvedId, "install must set the active companion");
}

// --- Gateway boot ---------------------------------------------------------

async function startGateway({ port, dataDir }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv({ port, dataDir }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

function gatewayEnv({ port, dataDir }) {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
    MOA_GATEWAY_TOKEN: TOKEN,
    // No model is exercised by these endpoints; keep providers unconfigured.
    MODEL_PROVIDER: "openai-compatible",
    MODEL_ID: "companion-character-smoke-model",
    MODEL_BASE_URL: "https://model.smoke.invalid/v1",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: "",
  };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // starting
    }
    if (logs.exited) throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
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
  child.on("exit", () => { logs.exited = true; });
  const logs = { exited: false, text: () => output };
  return logs;
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => child.kill("SIGKILL")),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
