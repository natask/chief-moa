import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const overlay = readFileSync(new URL("../extension/overlay.css", import.meta.url), "utf8");
const ribbons = readFileSync(new URL("../extension/ribbons.css", import.meta.url), "utf8");
const sidepanel = readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const sidepanelHtml = readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const draftControls = readFileSync(new URL("../extension/voice-draft-controls.js", import.meta.url), "utf8");
const draftCss = readFileSync(new URL("../extension/voice-draft-controls.css", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

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

test("the idle mascot stays legible without changing its footprint", () => {
  assert.match(overlay, /#agee-launcher\s*\{[\s\S]*?width:\s*2\.5em;[\s\S]*?height:\s*2\.5em;/);
  assert.match(overlay, /#agee-launcher \.agee-bird\s*\{[\s\S]*?width:\s*2em;[\s\S]*?height:\s*2em;/);
  assert.match(overlay, /:not\(\.agee-recording\) #agee-launcher \.agee-bird\s*\{\s*opacity:\s*1;/);
  assert.match(ribbons, /data-agee-unit="dormant"\] #agee-launcher \{ opacity: 0\.46; \}/);
});

test("blank ribbon padding passes through while content remains usable", () => {
  assert.match(ribbons, /\.agee-ribbon\.agee-ribbon-live\s*\{[\s\S]*?pointer-events:\s*none;/);
  assert.match(ribbons, /\.agee-ribbon-text\s*\{\s*pointer-events:\s*auto;/);
  assert.match(ribbons, /\.agee-ribbon-copy\s*\{[\s\S]*?pointer-events:\s*auto;/);
});

test("pointer cancellation never follows the release-to-send path", () => {
  assert.match(content, /if \(e\.type === "pointercancel"\) \{[\s\S]*?stopLiveVoiceTurn\("cancel"\);[\s\S]*?\} else (?:\{\s*)?finishLauncherPushToTalk\(\);/);
  assert.doesNotMatch(sidepanel, /pointercancel", \(\) => commitHold\(\)/);
  assert.match(sidepanel, /pointercancel", \(\) => cancelHold\(\)/);
  assert.match(sidepanel, /function cancelHold\(\)[\s\S]*?type: "cancel_turn"/);
});

test("capability-gated capture exposes only Cancel and Pause or Resume beside mascot Send", () => {
  assert.match(draftControls, /id="agee-draft-cancel"[^>]*>Cancel<\/button>/);
  assert.match(draftControls, /id="agee-draft-pause"[^>]*>Pause<\/button>/);
  assert.doesNotMatch(draftControls, /id="agee-draft-send"/);
  assert.match(draftControls, /launcher\.setAttribute\("aria-label", active \? "Send voice to Ag" : "Ag"\)/);
  assert.match(draftControls, /\["Enter", " "\]\.includes\(event\.key\)/);
  assert.match(draftControls, /cmd: "voiceDraftCapability"/);
  assert.match(draftControls, /toolbar\.hidden = !active/);
  assert.match(draftCss, /#agee-draft-controls\s*\{[\s\S]*?pointer-events:\s*none;/);
  assert.match(draftCss, /#agee-draft-controls button\s*\{[\s\S]*?pointer-events:\s*auto;/);
});

test("draft capture stays pre-execution until an exact authority-bound SEND", () => {
  assert.match(background, /voice_draft: voiceDraft/);
  assert.match(background, /validateClientRequest\(message, session\.voiceDraft\)/);
  assert.match(background, /action !== "resume"[^}]*stopOffscreenVoiceCapture/s);
  assert.match(background, /action === "discard"\) clearQueuedVoiceSessionMedia/);
  assert.match(background, /message\?\.type === "commit_turn"[\s\S]*?collectBrowserInvocationContext/);
  assert.match(background, /session\.draftMode\) \{\s*closeVoiceSession\(id, "voice draft capture backstop parked"\)/);
});

test("the fallback workspace shows the active companion identity", () => {
  assert.match(sidepanelHtml, /id="companionIdentity"/);
  assert.match(sidepanelHtml, /id="companionIdentityImage"[^>]*src="moa-mark\.png"/);
  assert.match(sidepanel, /function renderCompanionIdentity/);
  assert.match(sidepanel, /ageeActiveCompanionPetCache/);
});

test("retained assistant messages receive the same exact-copy control", () => {
  const renderBody = sidepanel.match(/function renderHistoryMessage\(message\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(renderBody, /item\.appendChild\(historyCopyButton\(message, \(\) => selectedTranscript\)\);/);
  assert.doesNotMatch(renderBody, /message\.speaker === "user"[\s\S]*?historyCopyButton/);
});
