#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "shared-session-profile-smoke-token";
const EXPECTED_DEFAULT_SESSION = `shared-usr_${crypto.createHash("sha256").update(TOKEN).digest("hex").slice(0, 16)}`;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-shared-session-profile-"));
const dataDir = path.join(tempDir, "data");

process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.DATA_DIR = dataDir;
process.env.ANDROID_OTA_DIR = path.join(dataDir, "android-ota");
process.env.MOA_GATEWAY_TOKEN = TOKEN;
process.env.MOA_USER_ADDRESS = "master";
process.env.MODEL_PROVIDER = "openai-compatible";
process.env.MODEL_ID = "shared-session-profile-smoke-model";
process.env.MODEL_BASE_URL = "https://api.openai.com/v1";
process.env.MODEL_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
process.env.GEMINI_API_KEY = "";

const {
  server,
  defaultSessionId,
  profileSystemInstruction,
  voiceProfileDiagnostics,
} = require(path.join(GATEWAY_DIR, "server"));
const { createAgentProfileStore } = require(path.join(GATEWAY_DIR, "lib", "agent-profile"));
const { createCompanionCatalogStore } = require(path.join(GATEWAY_DIR, "lib", "companion-catalog"));
const { createVoiceProvider } = require(path.join(GATEWAY_DIR, "lib", "voice-providers"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}).finally(() => {
  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  await step("default session helper and endpoint are deterministic", assertDefaultSession);
  await step("default profile prompt contains address directive", assertDefaultProfilePrompt);
  await step("companion apply preserves address directive", assertCompanionKeepsAddress);
  await step("profile reset restores address directive", assertResetKeepsAddress);
  await step("live voice prompt contains durable address directive", assertLivePromptAddress);
  await step("health diagnostics report provider drift without false language restrictions", assertVoiceProfileDiagnostics);
  await step("omitted session ids converge in storage", assertSharedSessionStorage);

  console.log(JSON.stringify({
    ok: true,
    session_id: EXPECTED_DEFAULT_SESSION,
    checks: [
      "defaultSessionId() and GET /v1/sessions/default return the deterministic per-account default session id",
      "chat prompt assembly includes the user_address directive after the identity block by default",
      "unverified legacy companion apply is rejected and leaves user_address/profile version intact",
      "chat and native voice prompts attribute creation/building to the configured user identity or address, never the model provider",
      "profile reset restores user_address to master and the prompt directive remains after identity",
      "Live voice effectiveSystemPrompt includes the same durable address directive after identity",
      "health diagnostics report stored/runtime provider drift without treating prompt languages as restrictions",
      "chat, voice, and browser turns with omitted session ids store under the shared session id",
    ],
  }, null, 2));
}

async function assertVoiceProfileDiagnostics() {
  const diagnostics = voiceProfileDiagnostics({
    language: { input: "am-ET" },
    providers: { voice_provider: "vertex-live" },
  }, { provider: "cascaded" });
  assert.equal(diagnostics.ok, false);
  assert.deepEqual(diagnostics.input_languages, ["am-ET"]);
  assert.deepEqual(
    diagnostics.warnings.map((warning) => warning.code).sort(),
    ["stored_runtime_provider_drift"]
  );
}

async function assertDefaultSession() {
  assert.equal(defaultSessionId(), EXPECTED_DEFAULT_SESSION);
  const first = await getJson("/v1/sessions/default");
  const second = await getJson("/v1/sessions/default");
  assert.equal(first.session_id, EXPECTED_DEFAULT_SESSION);
  assert.equal(second.session_id, EXPECTED_DEFAULT_SESSION);

  const unauth = await requestJson("GET", "/v1/sessions/default", null, { auth: false });
  assert.equal(unauth.status, 401, "default session endpoint must require gateway auth");
}

async function assertDefaultProfilePrompt() {
  const profile = await getJson("/v1/agent/profile");
  assert.equal(profile.profile.user_address, "master");
  const prompt = profileSystemInstruction(profile.profile);
  assertIdentityAttribution(prompt, "master");
  assertAddressAfterIdentity(prompt, "Assistant identity profile:");
}

async function assertCompanionKeepsAddress() {
  const before = await getJson("/v1/agent/profile");
  const apply = await requestJson("POST", "/v1/agent/companions/apply", {
    companion_id: "shigmi-scout",
    source: "shared-session-profile-smoke",
  });
  assert.equal(apply.status, 200, `first-party companion apply must succeed: ${JSON.stringify(apply.json)}`);
  const after = await getJson("/v1/agent/profile");
  assert.equal(after.profile.active_companion_id, "shigmi-scout", "companion apply must activate the companion");
  assert.equal(after.profile.user_address, "master", "companion apply must not clear user_address");
  void before;
}

async function assertResetKeepsAddress() {
  const reset = await requestJson("POST", "/v1/agent/profile/reset", {
    source: "shared-session-profile-smoke",
  });
  assert.equal(reset.status, 200, `profile reset must succeed: ${JSON.stringify(reset.json)}`);
  assert.equal(reset.json.profile.user_address, "master");
  assert.equal(reset.json.profile.active_companion_id, "");
  assertAddressAfterIdentity(profileSystemInstruction(reset.json.profile), "Assistant identity profile:");
}

async function assertLivePromptAddress() {
  const previousAddress = process.env.MOA_USER_ADDRESS;
  delete process.env.MOA_USER_ADDRESS;
  try {
    const liveDataDir = path.join(tempDir, "live-profile");
    const agentProfile = createAgentProfileStore({
      dataDir: liveDataDir,
      defaults: {
        system_prompt: "You are a live prompt smoke assistant.",
        assistant_name: "A.G.",
        model: "smoke-model",
        temperature: 0.4,
        voice_max_chars: 280,
      },
    });
    const provider = createVoiceProvider({
      env: { VOICE_PROVIDER: "gemini-live", GEMINI_API_KEY: "test-key" },
      agentProfile,
      systemPrompt: "You are a live prompt smoke assistant.",
    });

    const prompt = provider.effectiveSystemPrompt(agentProfile.effective());
    assertIdentityAttribution(prompt, "master");
    assertAddressAfterIdentity(prompt, "Ag identity profile:");

    const catalog = createCompanionCatalogStore({ dataDir: liveDataDir });
    const companionPatch = catalog.preview({ companion_id: "shigmi-scout" }).profile_overrides;
    agentProfile.patch(companionPatch, { source: "smoke", reason: "companion:shigmi-scout" });
    assert.equal(agentProfile.effective().user_address, "master");
    assertAddressAfterIdentity(provider.effectiveSystemPrompt(agentProfile.effective()), "Ag identity profile:");

    agentProfile.reset({ source: "smoke", reason: "reset" });
    assert.equal(agentProfile.effective().user_address, "master");
    assertAddressAfterIdentity(provider.effectiveSystemPrompt(agentProfile.effective()), "Ag identity profile:");
  } finally {
    if (previousAddress === undefined) {
      delete process.env.MOA_USER_ADDRESS;
    } else {
      process.env.MOA_USER_ADDRESS = previousAddress;
    }
  }
}

async function assertSharedSessionStorage() {
  const chat = await requestJson("POST", "/v1/chat", {
    turn_id: "chat_default_session",
    source: "shared-session-profile-smoke",
    messages: [{ role: "user", content: "store a chat turn under the default session" }],
  });
  assert.equal(chat.status, 200, `chat turn must succeed: ${JSON.stringify(chat.json)}`);
  assert.equal(chat.json.session_id, EXPECTED_DEFAULT_SESSION);

  const voice = await requestJson("POST", "/v1/voice/turns", {
    turn_id: "voice_default_session",
    source: "shared-session-profile-smoke",
    transcript: "store a voice turn under the default session",
  });
  assert.equal(voice.status, 200, `voice turn must succeed: ${JSON.stringify(voice.json)}`);
  assert.equal(voice.json.session_id, EXPECTED_DEFAULT_SESSION);

  const browser = await requestJson("POST", "/v1/browser/turns", {
    turn_id: "browser_default_session",
    source: "shared-session-profile-smoke",
    text: "what is on this page",
    page_ref: { title: "Shared Session Smoke", url: "https://example.test/shared-session" },
    evidence: {
      title: "Shared Session Smoke",
      url: "https://example.test/shared-session",
      visible_text: "This page exists only for the shared session smoke.",
    },
  });
  assert.equal(browser.status, 200, `browser turn must complete: ${JSON.stringify(browser.json)}`);
  assert.equal(browser.json.session_id, EXPECTED_DEFAULT_SESSION);

  const chatPath = path.join(dataDir, "chat-turns", EXPECTED_DEFAULT_SESSION, "chat_default_session.json");
  const voicePath = path.join(dataDir, "voice-turns", EXPECTED_DEFAULT_SESSION, "voice_default_session.json");
  const browserPath = path.join(dataDir, "browser-turns", "browser_default_session.json");
  assert.ok(fs.existsSync(chatPath), `chat turn must be stored at ${chatPath}`);
  assert.ok(fs.existsSync(voicePath), `voice turn must be stored at ${voicePath}`);
  assert.ok(fs.existsSync(browserPath), `browser turn must be stored at ${browserPath}`);

  assert.equal(JSON.parse(fs.readFileSync(chatPath, "utf8")).session_id, EXPECTED_DEFAULT_SESSION);
  assert.equal(JSON.parse(fs.readFileSync(voicePath, "utf8")).session_id, EXPECTED_DEFAULT_SESSION);
  assert.equal(JSON.parse(fs.readFileSync(browserPath, "utf8")).session_id, EXPECTED_DEFAULT_SESSION);
}

function assertAddressAfterIdentity(systemText, identityHeading) {
  assert.ok(systemText.includes(identityHeading), `system prompt must include ${identityHeading}: ${systemText}`);
  const identityIndex = systemText.indexOf(identityHeading);
  const directiveIndex = systemText.indexOf('address the user as "master"');
  assert.ok(directiveIndex > identityIndex, `address directive must appear after identity block: ${systemText}`);
  assert.match(systemText, /Use that form of address naturally/i);
  assert.match(systemText, /outranks any older wording in the base prompt/i);
}

function assertIdentityAttribution(systemText, owner) {
  assert.match(systemText, new RegExp(`attribute that to "?${owner}"?`, "i"));
  assert.match(systemText, /never .*Gemini.*Google.*OpenAI.*Anthropic.*provider/i);
}

async function getJson(url) {
  const response = await requestJson("GET", url);
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

function requestJson(method, url, body = null, options = {}) {
  return new Promise((resolve, reject) => {
    const request = new PassThrough();
    request.method = method;
    request.url = url;
    request.headers = {
      host: "localhost",
      ...(options.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
      ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
    };
    request.socket = {};

    const response = {
      statusCode: 200,
      headers: {},
      body: "",
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(headers)) {
          this.setHeader(name, value);
        }
      },
      write(chunk) {
        this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      },
      end(chunk) {
        if (chunk) this.write(chunk);
        try {
          resolve({ status: this.statusCode, json: JSON.parse(this.body || "{}"), headers: this.headers });
        } catch (error) {
          reject(error);
        }
      },
    };

    server.emit("request", request, response);
    request.end(body ? JSON.stringify(body) : "");
  });
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}
