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

// Chat sides are geometry (ribbon-layout.js), not text alignment: both lines
// stay left-anchored inside their own box so the sliding window owns the offset.
test("both lines stay anchored for the sliding window", () => {
  assert.match(
    ruleIn(ribbons, "#agee-ribbon-you .agee-ribbon-viewport,\n#agee-ribbon-reply .agee-ribbon-viewport"),
    /justify-content:\s*flex-start/,
  );
});

// Text mode is the same box with a caret in it, never a second surface.
test("the you-line is the text input", () => {
  const rule = ruleIn(ribbons, ".agee-ribbon-composing .agee-ribbon-text");
  assert.match(rule, /caret-color/);
  assert.match(rule, /cursor:\s*text/);
});

// An opened box is capped at five lines: it is still sitting on the page.
test("an opened box shows at most five lines", () => {
  assert.match(
    ruleIn(ribbons, ".agee-ribbon-expanded .agee-ribbon-viewport"),
    /max-height:\s*calc\(5 \* var\(--agee-ribbon-line-h\)\)/,
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
