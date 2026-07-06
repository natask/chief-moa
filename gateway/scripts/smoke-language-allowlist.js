#!/usr/bin/env node
"use strict";

// Language allowlist enforcement over the broadened catalog (every Google Chirp 3
// language). The requirement is that a language the model passes OUTSIDE the
// catalog is rejected gracefully and never breaks the profile: a bad value must
// leave the prior language in place, not blank it or crash. The catalog is the set
// the model picks codes from; it must include English + Amharic and many more.
//
// Drives the REAL agent-profile store against a temp data dir (no server, no
// network) so it exercises the same patch path the PUT endpoint and the profile
// tools use.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentProfileStore } = require("../lib/agent-profile");
const {
  languageOptionsPayload,
  normalizeLanguageList,
  mentionsSupportedLanguage,
} = require("../lib/profile-options");

main();

function main() {
  assertCatalogIsBroadened();
  assertRejectsUnknownLanguage();
  assertRejectsMixedValidAndInvalidWhole();
  assertAcceptsAllowed();
  assertProfileSurvivesRejectedPatch();
  console.log(JSON.stringify({
    ok: true,
    checks: [
      "options catalog is the broadened Chirp 3 set (includes en-US, am-ET, es-ES, ja-JP; >2 languages)",
      "a code outside the catalog (zz-ZZ) is rejected and the prior language survives",
      "a mixed valid+invalid list (zz-ZZ,am-ET) is rejected whole, not partially applied",
      "any allowed pair (en-US,am-ET and es-ES,fr-FR) is accepted for reply and input languages",
      "the profile still validates after a rejected patch (no setting change breaks the app)",
    ],
  }, null, 2));
}

function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-lang-allowlist-"));
  try {
    const store = createAgentProfileStore({ dataDir: dir });
    run(store);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertCatalogIsBroadened() {
  const languages = languageOptionsPayload();
  assert.ok(languages.length > 2, "language catalog must be broadened beyond two languages");
  const byCode = new Map(languages.map((language) => [language.code, language.label]));
  assert.equal(byCode.get("en-US"), "English", "en-US must be labeled English");
  assert.equal(byCode.get("am-ET"), "Amharic", "am-ET must be labeled Amharic");
  for (const code of ["es-ES", "fr-FR", "ja-JP", "ar-XA", "cmn-Hans-CN"]) {
    assert.ok(byCode.has(code), `catalog must expose ${code}`);
  }
  // Every entry is a usable {code,label} the model can pick from.
  for (const language of languages) {
    assert.ok(/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(language.code), `catalog code must be BCP-47-shaped: ${language.code}`);
    assert.ok(language.label && typeof language.label === "string", `catalog entry ${language.code} must have a label`);
  }
  // The routing membership test recognizes catalog languages but not nonsense.
  assert.ok(mentionsSupportedLanguage("please answer in Amharic"), "membership test must see a supported language");
  assert.ok(!mentionsSupportedLanguage("please download the file"), "membership test must not false-positive on ordinary speech");
}

function assertRejectsUnknownLanguage() {
  withStore((store) => {
    const before = store.effective().language;
    // zz-ZZ is not a real BCP-47 language in the catalog.
    store.patch({ language: "zz-ZZ" }, { source: "smoke", scope: "global" });
    assert.equal(
      store.effective().language,
      before,
      "an unknown reply language must be dropped, leaving the prior value unchanged",
    );
    const beforeInput = store.effective().input_languages;
    store.patch({ input_languages: "qya-AA" }, { source: "smoke", scope: "global" });
    assert.equal(
      store.effective().input_languages,
      beforeInput,
      "an unknown input language must be dropped, leaving the prior value unchanged",
    );
    // The catalog normalizer agrees: an out-of-catalog code does not resolve.
    assert.equal(normalizeLanguageList("zz-ZZ").codes.length, 0, "an out-of-catalog code must not normalize");
  });
}

function assertRejectsMixedValidAndInvalidWhole() {
  withStore((store) => {
    const before = store.effective().language;
    store.patch({ language: "zz-ZZ,am-ET" }, { source: "smoke", scope: "global" });
    assert.equal(
      store.effective().language,
      before,
      "a list containing any unsupported code must be rejected whole, not partially applied to am-ET",
    );
  });
}

function assertAcceptsAllowed() {
  withStore((store) => {
    store.patch({ language: "en-US,am-ET" }, { source: "smoke", scope: "global" });
    assert.equal(store.effective().language, "en-US,am-ET", "the allowed reply pair must be accepted");
    store.patch({ input_languages: "en-US,am-ET" }, { source: "smoke", scope: "global" });
    assert.equal(store.effective().input_languages, "en-US,am-ET", "the allowed input pair must be accepted");
    // A pair from the broadened catalog must also work, proving it is not a
    // hard-coded English/Amharic switch.
    store.patch({ language: "es-ES,fr-FR" }, { source: "smoke", scope: "global" });
    assert.equal(store.effective().language, "es-ES,fr-FR", "a broadened allowed pair must be accepted");
    // Single allowed languages must work too, since the user can name just one.
    store.patch({ language: "am-ET" }, { source: "smoke", scope: "global" });
    assert.equal(store.effective().language, "am-ET", "a single allowed language must be accepted");
  });
}

function assertProfileSurvivesRejectedPatch() {
  withStore((store) => {
    store.patch({ language: "zz-ZZ", input_languages: "qya-AA" }, { source: "smoke", scope: "global" });
    const effective = store.effective();
    // After a fully rejected language patch the profile is still coherent: the
    // effective reply/input language stays a real code, so nothing broke.
    assert.ok(
      normalizeLanguageList(effective.input_languages || "en-US").codes.length > 0,
      `effective input language must stay real after a rejected patch, got ${effective.input_languages}`,
    );
  });
}
