// Unit test for the pure cue-card selection/formatting helpers that back the
// persistent-overlay cascade-dismiss control and the language chip.
//
// content.js is a plain (non-module) content script, so these helpers cannot
// be imported directly like extension/voice-sampler-runtime.js. Instead this
// test extracts the exact function source for each pure helper out of
// extension/content.js by brace-matching on its signature, then evaluates
// that source in an isolated vm context — so the test runs against the real
// production code, not a hand-copied duplicate that could drift from it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const contentSource = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`could not find function ${name} in content.js`);
  const braceOpen = source.indexOf("{", start);
  if (braceOpen === -1) throw new Error(`could not find body for ${name}`);
  let depth = 0;
  let end = -1;
  for (let i = braceOpen; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`unbalanced braces extracting ${name}`);
  return source.slice(start, end);
}

const helperNames = ["selectCascadeDismissIds", "shortLangTag", "parseLanguageCodes", "formatLanguageChipText"];
const helperSource = helperNames.map((name) => extractFunction(contentSource, name)).join("\n\n");

const context = vm.createContext({});
vm.runInContext(
  `${helperSource}\nglobalThis.__cueHelpers = { selectCascadeDismissIds, shortLangTag, parseLanguageCodes, formatLanguageChipText };`,
  context,
);
const vmHelpers = context.__cueHelpers;
// The helpers run inside the vm context, so arrays/objects they return carry
// that realm's Array/Object prototypes. Re-materialize results as host-realm
// values on the way out so assert.deepEqual (which is prototype-strict) can
// compare them normally.
const selectCascadeDismissIds = (...args) => [...vmHelpers.selectCascadeDismissIds(...args)];
const formatLanguageChipText = (...args) => String(vmHelpers.formatLanguageChipText(...args));

// ---- selectCascadeDismissIds -------------------------------------------
// Oldest-first card list, mirroring #agee-log DOM order (appendChild == newest last).
const cards = [
  { id: "a", active: false },
  { id: "b", active: false },
  { id: "c", active: false },
];

// Clicking the newest finished card removes everything at and above it.
assert.deepEqual(selectCascadeDismissIds(cards, "c"), ["a", "b", "c"]);
// Clicking a middle card removes it and only the older ones, not the newer one.
assert.deepEqual(selectCascadeDismissIds(cards, "b"), ["a", "b"]);
// Clicking the oldest card removes only itself.
assert.deepEqual(selectCascadeDismissIds(cards, "a"), ["a"]);
// Unknown id: nothing to remove.
assert.deepEqual(selectCascadeDismissIds(cards, "nope"), []);
// Empty/garbage input never throws.
assert.deepEqual(selectCascadeDismissIds([], "a"), []);
assert.deepEqual(selectCascadeDismissIds(null, "a"), []);

// An in-flight (active) card is never dismissable — clicking it is a no-op...
const withActiveClicked = [
  { id: "a", active: false },
  { id: "b", active: true },
];
assert.deepEqual(selectCascadeDismissIds(withActiveClicked, "b"), []);

// ...and an in-flight card caught in someone else's cascade is skipped, not
// torn down, while the finished cards around it still get dismissed.
const withActiveInMiddle = [
  { id: "a", active: false },
  { id: "b", active: true },
  { id: "c", active: false },
];
assert.deepEqual(selectCascadeDismissIds(withActiveInMiddle, "c"), ["a", "c"]);

console.log("selectCascadeDismissIds tests passed");

// ---- formatLanguageChipText ---------------------------------------------
assert.equal(
  formatLanguageChipText({ input_languages: "en-US,am-ET", language_primary: "am-ET" }, ""),
  "Hears en·am · Speaks am",
);
// A live reply_language from the current turn overrides the profile default.
assert.equal(
  formatLanguageChipText({ input_languages: "en-US,am-ET", language_primary: "en-US" }, "am-ET"),
  "Hears en·am · Speaks am",
);
// Falls back to input_language_primary when input_languages is unset.
assert.equal(
  formatLanguageChipText({ input_language_primary: "en-US", language: "en-US" }, ""),
  "Hears en · Speaks en",
);
// Falls back to `language` (comma list) for the spoken side, taking the first code.
assert.equal(
  formatLanguageChipText({ input_languages: "am-ET", language: "am-ET,en-US" }, ""),
  "Hears am · Speaks am",
);
// No usable data at all: empty string, never "undefined"/"null" text.
assert.equal(formatLanguageChipText({}, ""), "");
assert.equal(formatLanguageChipText(null, ""), "");
assert.equal(formatLanguageChipText(undefined, undefined), "");
// Only one side known: the chip shows just that side.
assert.equal(formatLanguageChipText({ input_languages: "en-US" }, ""), "Hears en");
assert.equal(formatLanguageChipText({ language_primary: "am-ET" }, ""), "Speaks am");

console.log("formatLanguageChipText tests passed");
