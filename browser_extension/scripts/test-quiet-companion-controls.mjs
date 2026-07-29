import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/quiet-companion-controls.js", import.meta.url), "utf8");
const sandbox = { globalThis: {}, setTimeout, clearTimeout };
vm.runInNewContext(source, sandbox);
const controls = sandbox.globalThis.AgeeQuietCompanionControls;

test("quiet controls expose only copy and voice buttons", () => {
  const markup = controls.template();
  assert.match(markup, /id="agee-quiet-copy"/);
  assert.match(markup, /id="agee-quiet-voice"/);
  assert.doesNotMatch(markup, /history|settings|record/i);
});

test("voice starts enabled and explains the local toggle", () => {
  const markup = controls.template();
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /Turn voice replies off/);
});
