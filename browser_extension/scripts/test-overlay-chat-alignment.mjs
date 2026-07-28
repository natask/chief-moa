import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../extension/overlay.css", import.meta.url), "utf8");

const ruleFor = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] || "";
};

test("current and historical user bubbles align opposite assistant bubbles", () => {
  assert.match(ruleFor(".agee-cue .agee-you"), /margin:\s*0 0 9px auto/);
  assert.match(ruleFor(".agee-history-you"), /align-self:\s*flex-end/);
  assert.match(ruleFor(".agee-history-assistant"), /align-self:\s*flex-start/);
  assert.match(ruleFor(".agee-cue-status"), /width:\s*fit-content/);
});

test("empty transient shells stay hidden", () => {
  assert.match(ruleFor("#agee-root.agee-has-ui-spec #agee-ui-surface:empty"), /display:\s*none/);
  assert.match(ruleFor(".agee-history-turn:empty"), /display:\s*none/);
  assert.match(ruleFor(".agee-row:empty"), /display:\s*none/);
  assert.match(ruleFor(".agee-cue .agee-you:empty"), /display:\s*none/);
  assert.match(ruleFor(".agee-cue-status:empty"), /display:\s*none/);
});

test("narrow screens retain readable opposing bubble widths", () => {
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*\.agee-history-assistant\s*\{\s*max-width:\s*92%/);
});
