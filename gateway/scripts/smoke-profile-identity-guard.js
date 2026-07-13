#!/usr/bin/env node
"use strict";

// Regression for the "who created you?" -> "Google" leak (2026-07-13 __LOG__.md
// complaint): the assembled system instruction must answer identity, creator/
// ownership, and address-form questions from the user's configured profile,
// never from the underlying model vendor (Google/Gemini/OpenAI/Anthropic/etc).
//
// Covers BOTH assembly points that carry this guard:
//   1. server.js profileSystemInstruction -- the cascaded/HTTP chat pipeline
//      (primary path: Chirp 3 STT -> gateway LLM turn -> Chirp 3 TTS).
//   2. lib/voice-providers.js effectiveSystemPrompt on the gemini-live/
//      vertex-live provider -- the switchable legacy-live pipeline, which
//      historically carries its own duplicated copy of the identity/address
//      instruction builders and must not silently drift out of sync.
//
// No network calls; asserts on the assembled prompt strings only.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GATEWAY_DIR = path.resolve(__dirname, "..");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-profile-identity-guard-"));
const dataDir = path.join(tempDir, "data");

process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.MOA_MODE = "local";
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;
process.env.ANDROID_OTA_DIR = path.join(process.env.DATA_DIR, "android-ota");
process.env.MOA_GATEWAY_TOKEN = "profile-identity-guard-smoke-token";
process.env.ACCOUNT_HEALTH_INTERVAL_MS = "0";

const { profileSystemInstruction } = require(path.join(GATEWAY_DIR, "server"));
const { createVoiceProvider } = require(path.join(GATEWAY_DIR, "lib", "voice-providers"));

// Phrases the base model defaults to when nothing overrides it ("who created
// you?" -> "Google" on Gemini). The guard must forbid crediting any of these as
// the assistant's creator.
const VENDOR_NAMES = ["Google", "Gemini", "OpenAI", "Anthropic"];

function assertIdentityGuard(prompt, label) {
  assert.ok(prompt.includes("A.G."), `${label}: expected assistant name A.G. in prompt`);
  assert.ok(prompt.includes("master"), `${label}: expected user_address "master" in prompt`);
  const lower = prompt.toLowerCase();
  assert.ok(
    /who made|who created|who owns|creator/.test(lower),
    `${label}: expected an explicit creator/ownership instruction`
  );
  for (const vendor of VENDOR_NAMES) {
    assert.ok(
      prompt.includes(vendor),
      `${label}: expected the guard to name-check vendor "${vendor}" as a forbidden creator answer`
    );
  }
  assert.ok(
    /never credit/i.test(prompt),
    `${label}: expected the guard to explicitly forbid crediting the vendor as creator`
  );
}

function main() {
  const defaultProfile = { assistant_name: "A.G.", user_address: "master" };

  // 1. Cascaded/HTTP pipeline: default profile (no custom persona system_prompt).
  const cascadedPrompt = profileSystemInstruction(defaultProfile);
  assertIdentityGuard(cascadedPrompt, "server.js profileSystemInstruction (default)");

  // 2. Cascaded/HTTP pipeline with a user-configured persona system_prompt. The
  // persona replaces the fallback SYSTEM_PROMPT text entirely (see
  // safeSystemPromptForProvider), so the guard must be layered on
  // unconditionally afterward rather than living only inside the base prompt.
  const personaProfile = {
    assistant_name: "A.G.",
    user_address: "master",
    system_prompt: "You are a cheerful terse pirate first mate.",
  };
  const personaPrompt = profileSystemInstruction(personaProfile);
  assertIdentityGuard(personaPrompt, "server.js profileSystemInstruction (custom persona)");

  // 3. Legacy-live pipeline (Gemini Live / Vertex Live): its own duplicated
  // instruction builder must carry the same guard so the two pipelines cannot
  // drift out of sync again.
  const legacyLiveProvider = createVoiceProvider({
    env: { VOICE_PROVIDER: "gemini-live", GEMINI_API_KEY: "test-key" },
    systemPrompt: "You are A.G.",
  });
  const legacyLivePrompt = legacyLiveProvider.effectiveSystemPrompt(defaultProfile);
  assertIdentityGuard(legacyLivePrompt, "voice-providers.js effectiveSystemPrompt (gemini-live)");

  console.log("smoke-profile-identity-guard: OK");
}

main();
