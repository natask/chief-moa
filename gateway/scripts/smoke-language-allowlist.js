#!/usr/bin/env node
"use strict";

// Language allowlist enforcement: English (en-US) and Amharic (am-ET) only, and
// user-specifiable from that catalog. The requirement is that a language the user
// names outside the allowlist is rejected gracefully and never breaks the
// profile: a bad value must leave the prior language in place, not blank it or
// crash. The two allowed languages are a catalog the user picks from by voice,
// not a hard-coded switch, so the catalog must list exactly the two.
//
// Drives the REAL agent-profile store against a temp data dir (no server, no
// network) so it exercises the same patch path the PUT endpoint uses.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentProfileStore } = require("../lib/agent-profile");
const { languageOptionsPayload } = require("../lib/profile-options");

main();

function main() {
  assertCatalogIsExactlyTwo();
  assertRejectsUnknownLanguage();
  assertRejectsMixedValidAndInvalidWhole();
  assertAcceptsBothAllowed();
  assertProfileSurvivesRejectedPatch();
  console.log(JSON.stringify({
    ok: true,
    checks: [
      "options catalog lists exactly English (en-US) and Amharic (am-ET)",
      "an unknown language (fr-FR) is rejected and the prior language survives",
      "a mixed valid+invalid list (es-ES,am-ET) is rejected whole, not partially applied",
      "the allowed pair en-US,am-ET is accepted for both reply and input languages",
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

function assertCatalogIsExactlyTwo() {
  const languages = languageOptionsPayload();
  assert.equal(languages.length, 2, "language catalog must list exactly two languages");
  const codes = languages.map((language) => language.code).sort();
  assert.deepEqual(codes, ["am-ET", "en-US"], "language catalog codes must be exactly en-US and am-ET");
  const byCode = new Map(languages.map((language) => [language.code, language.label]));
  assert.equal(byCode.get("en-US"), "English", "en-US must be labeled English");
  assert.equal(byCode.get("am-ET"), "Amharic", "am-ET must be labeled Amharic");
}

function assertRejectsUnknownLanguage() {
  withStore((store) => {
    const before = store.effective().language;
    store.patch({ language: "fr-FR" }, { source: "smoke", scope: "global" });
    assert.equal(
      store.effective().language,
      before,
      "an unknown reply language must be dropped, leaving the prior value unchanged",
    );
    const beforeInput = store.effective().input_languages;
    store.patch({ input_languages: "de-DE" }, { source: "smoke", scope: "global" });
    assert.equal(
      store.effective().input_languages,
      beforeInput,
      "an unknown input language must be dropped, leaving the prior value unchanged",
    );
  });
}

function assertRejectsMixedValidAndInvalidWhole() {
  withStore((store) => {
    const before = store.effective().language;
    store.patch({ language: "es-ES,am-ET" }, { source: "smoke", scope: "global" });
    assert.equal(
      store.effective().language,
      before,
      "a list containing any unsupported code must be rejected whole, not partially applied to am-ET",
    );
  });
}

function assertAcceptsBothAllowed() {
  withStore((store) => {
    store.patch({ language: "en-US,am-ET" }, { source: "smoke", scope: "global" });
    assert.equal(store.effective().language, "en-US,am-ET", "the allowed reply pair must be accepted");
    store.patch({ input_languages: "en-US,am-ET" }, { source: "smoke", scope: "global" });
    assert.equal(store.effective().input_languages, "en-US,am-ET", "the allowed input pair must be accepted");
    // Single allowed languages must work too, since the user can name just one.
    store.patch({ language: "am-ET" }, { source: "smoke", scope: "global" });
    assert.equal(store.effective().language, "am-ET", "a single allowed language must be accepted");
  });
}

function assertProfileSurvivesRejectedPatch() {
  withStore((store) => {
    store.patch({ language: "fr-FR", input_languages: "ja-JP" }, { source: "smoke", scope: "global" });
    const effective = store.effective();
    // After a fully rejected language patch the profile is still coherent: the
    // effective reply language is a real allowed code, so nothing broke.
    assert.ok(
      ["en-US", "am-ET", "en-US,am-ET", "am-ET,en-US"].includes(effective.language),
      `effective language must stay a real allowed value after a rejected patch, got ${effective.language}`,
    );
  });
}
