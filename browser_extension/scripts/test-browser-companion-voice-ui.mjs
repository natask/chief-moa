import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const overlay = readFileSync(new URL("../extension/overlay.css", import.meta.url), "utf8");
const ribbons = readFileSync(new URL("../extension/ribbons.css", import.meta.url), "utf8");

test("the companion has no circular state ring", () => {
  assert.doesNotMatch(content, /class="agee-ring"/);
  assert.doesNotMatch(overlay, /agee-ring|agee-rim-think|agee-talk-ring/);
});

test("listening opens and focuses the user transcription box", () => {
  const stateBody = content.match(/function setAgentState\(next\) \{([\s\S]*?)\n  \}\n\n  \/\/ The upper ribbon/)?.[1] || "";
  assert.match(stateBody, /ribbons\?\.setUserPending\(next === "listening"\);/);
  assert.match(stateBody, /focusTranscriptionComposer\(next === "listening"\);/);
  assert.ok(
    stateBody.indexOf("setUserPending") < stateBody.indexOf("focusTranscriptionComposer"),
    "the empty pending bubble must open before focus moves into it",
  );
  assert.match(content, /#agee-ribbon-you \.agee-ribbon-text/);
  assert.match(content, /if \(active\) \{[^}]*target\.setAttribute\(name, value\)/s);
  assert.match(content, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(content, /document\.activeElement === target\) try \{ target\.blur\(\);/);
  assert.match(content, /target\.removeAttribute\(name\)/);
  assert.doesNotMatch(content, /AgeeCompanionRim|companionRim\?\./);
});

test("the pending user bubble paints a synthetic blinking caret", () => {
  assert.match(ribbons, /\.agee-ribbon-caret\s*\{[^}]*width:\s*2px;[^}]*height:\s*16px;/s);
  assert.match(ribbons, /\.agee-ribbon-pending \.agee-ribbon-caret\s*\{[^}]*animation:\s*agee-ribbon-caret 1060ms/s);
  assert.match(overlay, /#agee-ribbon-you\.agee-ribbon-pending \.agee-ribbon-text:focus\s*\{[^}]*outline:\s*none;/s);
});
