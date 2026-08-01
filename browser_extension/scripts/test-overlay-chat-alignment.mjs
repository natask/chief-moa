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

// Chat sides are geometry (ribbon-layout.js), not text alignment. The bubble
// wraps inside a bounded block viewport and the runtime pins it to the tail;
// the sliding window and the flex row it needed are gone.
test("the bubble wraps inside a bounded viewport", () => {
  const line = ruleIn(ribbons, ".agee-ribbon-line");
  assert.match(line, /white-space:\s*pre-wrap/);
  assert.doesNotMatch(line, /will-change:\s*transform/);
  const viewport = ruleIn(ribbons, ".agee-ribbon-viewport");
  assert.match(viewport, /display:\s*block/);
  assert.match(viewport, /overflow:\s*hidden/);
  assert.match(viewport, /max-height:\s*calc\(var\(--agee-ribbon-lines\) \* var\(--agee-ribbon-line-h\)\)/);
});

// New text arrives at the bottom; the oldest line leaves off the TOP under a
// short fade. A horizontal fade would be the sliding window coming back.
test("overflowing text fades off the top, not the side", () => {
  assert.match(
    ruleIn(ribbons, ".agee-ribbon-clipped .agee-ribbon-viewport"),
    /mask-image:\s*linear-gradient\(to bottom, transparent 0, #000 var\(--agee-ribbon-fade\)\)/,
  );
});

// Text mode is the same box with a caret in it, never a second surface.
test("the you-line is the text input", () => {
  const rule = ruleIn(ribbons, ".agee-ribbon-composing .agee-ribbon-text");
  assert.match(rule, /caret-color/);
  assert.match(rule, /cursor:\s*text/);
});

// Collapsed is one fixed streaming line and opened is exactly three scrollable
// lines, matching Android.
test("the bubble is one line collapsed and three lines opened", () => {
  assert.match(ribbons, /--agee-ribbon-lines:\s*1;/);
  assert.match(ribbons, /--agee-ribbon-expanded-lines:\s*3;/);
  assert.match(
    ruleIn(ribbons, ".agee-ribbon-expanded .agee-ribbon-viewport"),
    /height:\s*calc\(var\(--agee-ribbon-expanded-lines\) \* var\(--agee-ribbon-line-h\)\)/,
  );
  assert.match(
    ruleIn(ribbons, ".agee-ribbon"),
    /height:\s*calc\(var\(--agee-ribbon-lines\) \* var\(--agee-ribbon-line-h\) \+ 2 \* var\(--agee-ribbon-pad-y\)\)/,
  );
});

test("empty transient shells stay hidden", () => {
  assert.match(ruleFor("#agee-root.agee-has-ui-spec #agee-ui-surface:empty"), /display:\s*none/);
  assert.match(ruleFor(".agee-row:empty"), /display:\s*none/);
});

test("exceptional control shells contain no conversation presentation", () => {
  assert.match(ruleFor(".agee-control-card"), /background:\s*rgba\(255, 255, 255, 0\.035\)/);
  for (const gone of ["#agee-log", ".agee-cue", ".agee-cue-status", ".agee-you"]) {
    assert.equal(css.includes(gone), false, `${gone} should not remain in overlay.css`);
  }
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
    "#agee-input",
  ]) {
    assert.equal(css.includes(gone), false, `${gone} should be gone from overlay.css`);
  }
});
