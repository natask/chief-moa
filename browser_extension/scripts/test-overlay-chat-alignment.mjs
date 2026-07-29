import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../extension/overlay.css", import.meta.url), "utf8");
const ribbons = await readFile(new URL("../extension/ribbons.css", import.meta.url), "utf8");

const ruleIn = (source, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] || "";
};
const ruleFor = (selector) => ruleIn(css, selector);

// The turn reads in the two ribbons around the companion: what you said above,
// what Ag replied below, opposite sides, centred on the mark between them.
test("the two ribbons take opposite chat sides", () => {
  assert.match(ruleIn(ribbons, "#agee-ribbon-you .agee-ribbon-viewport"), /justify-content:\s*flex-end/);
  assert.match(ruleIn(ribbons, "#agee-ribbon-you .agee-ribbon-line"), /text-align:\s*right/);
  assert.match(ruleIn(ribbons, "#agee-ribbon-reply .agee-ribbon-viewport"), /justify-content:\s*flex-start/);
});

// A clipped line is owned by the sliding window, which anchors it left and
// moves it with translateX. Alignment must step out of the way there.
test("a clipped user ribbon returns to the sliding window's anchor", () => {
  assert.match(
    ruleIn(ribbons, "#agee-ribbon-you.agee-ribbon-clipped .agee-ribbon-viewport"),
    /justify-content:\s*flex-start/,
  );
});

// Cards survive only for turns that grew a control (approval, dictation copy,
// microphone recovery). They keep the same sides as the ribbons.
test("surviving cards align the user opposite the assistant", () => {
  assert.match(ruleFor(".agee-cue .agee-you"), /margin:\s*0 0 9px auto/);
  assert.match(ruleFor(".agee-cue-status"), /width:\s*fit-content/);
});

test("empty transient shells stay hidden", () => {
  assert.match(ruleFor("#agee-root.agee-has-ui-spec #agee-ui-surface:empty"), /display:\s*none/);
  assert.match(ruleFor(".agee-row:empty"), /display:\s*none/);
  assert.match(ruleFor(".agee-cue .agee-you:empty"), /display:\s*none/);
  assert.match(ruleFor(".agee-cue-status:empty"), /display:\s*none/);
});

test("narrow screens retain readable bubble widths", () => {
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*\.agee-cue-status\s*\{\s*max-width:\s*92%/);
});

// The overlay is the companion and its ribbons. The panel is a composer, not a
// place that shows page identity, saved history, or a language chip.
test("the panel carries no legacy chrome", () => {
  for (const gone of [
    "#agee-page-context",
    "#agee-page-identity",
    "#agee-history-button",
    "#agee-copy-history",
    ".agee-lang-chip",
    "#agee-voice-state",
    "#agee-transcript",
  ]) {
    assert.equal(css.includes(gone), false, `${gone} should be gone from overlay.css`);
  }
});
