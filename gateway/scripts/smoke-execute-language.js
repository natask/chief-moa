#!/usr/bin/env node
"use strict";

// Code-mode language skill (`set_languages`) parity smoke. Proves the QuickJS
// sandbox skill mutates the durable agent profile the SAME way the classic
// update_agent_profile tool does, so "we only specify skills and the model uses
// them" holds for language control. Deterministic: no server, no network — it
// drives the REAL execute engine (lib/execute-engine) and the REAL agent-profile
// store against temp data dirs.
//
// Asserts:
//   1. A model-written script calling tools.moa.set_languages({...}) inside the
//      sandbox constrains the understood set and pins the reply language.
//   2. The resulting profile is IDENTICAL to applying the equivalent classic
//      update_agent_profile fields directly (languageControlPatch is the one
//      shared mapping; the sanitizer is the one shared validator).
//   3. Reordering the understood primary ("right now I want to speak X") only
//      moves input_language_primary; the understood set is unchanged.
//   4. An out-of-catalog language is dropped by the sandbox path too (the skill
//      cannot blank a field).

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runExecuteCode } = require("../lib/execute-engine");
const { createAgentProfileStore } = require("../lib/agent-profile");
const { languageControlPatch } = require("../lib/profile-options");

const LANGUAGE_FIELDS = [
  "input_languages",
  "input_language_primary",
  "language",
  "language_primary",
  "language_mode",
  "language_output",
  "language_auto_switch",
];

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-exec-lang-"));
  try {
    return await run(createAgentProfileStore({ dataDir: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The same capability the gateway registers under VOICE_EXECUTE_TOOL, bound to a
// store: languageControlPatch maps the friendly args to profile fields, then the
// store's sanitizer validates and persists.
function languageCapabilities(store) {
  return {
    profile_get: {
      description: "Read the effective profile",
      run: () => ({ ok: true, profile: store.effective() }),
    },
    set_languages: {
      description: "Set understood and reply languages",
      run: (args) => {
        const patch = languageControlPatch(args || {});
        if (Object.keys(patch).length === 0) {
          return { ok: false, error: "no languages provided" };
        }
        store.patch(patch, { source: "voice-execute-languages", scope: "global" });
        return { ok: true, profile: store.effective() };
      },
    },
  };
}

function languageState(profile) {
  const out = {};
  for (const field of LANGUAGE_FIELDS) {
    out[field] = profile[field];
  }
  return out;
}

async function main() {
  // 1 + 2. The sandbox skill and the classic tool reach the same profile.
  const viaSkill = await withStore(async (store) => {
    const outcome = await runExecuteCode({
      code: `
        const before = await tools.moa.profile_get({});
        console.log("before understand", before.data.profile.input_languages);
        const r = await tools.moa.set_languages({
          understand: ["English", "Amharic"],
          understand_primary: "Amharic",
          reply: "English",
          lock: true,
        });
        return r.data.profile.input_languages;
      `,
      capabilities: languageCapabilities(store),
    });
    assert.equal(outcome.ok, true, `sandbox script must run: ${outcome.error || ""}`);
    return languageState(store.effective());
  });

  const viaClassic = await withStore((store) => {
    // The classic update_agent_profile path applies explicit profile fields.
    store.patch(
      {
        input_languages: "en-US,am-ET",
        input_language_primary: "am-ET",
        language: "en-US",
        language_mode: "explicit",
        language_output: "primary_only",
        language_auto_switch: false,
      },
      { source: "classic-tool", scope: "global" },
    );
    return languageState(store.effective());
  });

  assert.deepEqual(viaSkill, viaClassic, "code-mode set_languages must mutate the profile identically to the classic tool");
  assert.equal(viaSkill.input_languages, "en-US,am-ET", "understood set must be exactly the requested pair");
  assert.equal(viaSkill.input_language_primary, "am-ET", "understood primary must follow understand_primary");
  assert.equal(viaSkill.language, "en-US", "reply language must be pinned");
  assert.equal(viaSkill.language_auto_switch, false, "lock must disable auto switch");

  // 3. Reordering only moves the primary; the understood set is unchanged.
  const reordered = await withStore(async (store) => {
    store.patch({ input_languages: "en-US,am-ET", input_language_primary: "en-US" }, { source: "seed", scope: "global" });
    const outcome = await runExecuteCode({
      code: `return (await tools.moa.set_languages({ understand_primary: "Amharic" })).data.profile.input_language_primary;`,
      capabilities: languageCapabilities(store),
    });
    assert.equal(outcome.ok, true, `reorder script must run: ${outcome.error || ""}`);
    return store.effective();
  });
  assert.equal(reordered.input_language_primary, "am-ET", "understood primary must switch to am-ET");
  assert.equal(reordered.input_languages, "en-US,am-ET", "understood set must be unchanged by a primary switch");

  // 4. An out-of-catalog language is dropped, never blanking the field.
  const rejected = await withStore(async (store) => {
    store.patch({ input_languages: "en-US,am-ET" }, { source: "seed", scope: "global" });
    const outcome = await runExecuteCode({
      code: `return (await tools.moa.set_languages({ understand: ["Klingon"] })).data;`,
      capabilities: languageCapabilities(store),
    });
    assert.equal(outcome.ok, true, `rejected script must still run: ${outcome.error || ""}`);
    return store.effective();
  });
  assert.equal(rejected.input_languages, "en-US,am-ET", "an out-of-catalog language must be dropped, keeping the prior set");

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "code-mode set_languages constrains the understood set and pins the reply language in the QuickJS sandbox",
      "the sandbox skill and the classic update_agent_profile tool reach an identical profile",
      "reordering understand_primary moves only the primary; the understood set is unchanged",
      "an out-of-catalog language is dropped by the skill path without blanking the field",
    ],
  }, null, 2));
}
