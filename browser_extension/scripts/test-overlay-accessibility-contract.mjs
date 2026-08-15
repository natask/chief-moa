import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const ribbons = readFileSync(new URL("../extension/ribbon-runtime.js", import.meta.url), "utf8");

test("launcher routes native keyboard activation without replaying pointer clicks", () => {
  assert.match(content, /if \(e\.detail !== 0\) return;/);
  assert.match(content, /toggleVoiceFirstCapture\("keyboard"\)/);
  assert.match(content, /else ribbons\?\.beginCompose\(\)/);
});

test("live voice preserves page focus instead of focusing its transcript", () => {
  assert.match(content, /rememberPageFocusBeforeVoice\(\)/);
  assert.match(content, /restorePageFocusAfterVoice\(\)/);
  const focusHelper = content.slice(
    content.indexOf("function focusTranscriptionComposer"),
    content.indexOf("const REPLY_TRAIL_MAX")
  );
  assert.doesNotMatch(focusHelper, /\.focus\(/);
});

test("ribbon menus expose standard focus, escape, and arrow behavior", () => {
  assert.match(ribbons, /aria-haspopup="menu" aria-expanded="false"/);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Tab"]) {
    assert.match(ribbons, new RegExp(`event\\.key === "${key}"`));
  }
  assert.match(ribbons, /enabledMenuItems\(menuEl\)\[0\]\?\.focus/);
  assert.match(ribbons, /enabledMenuItems\(copyMenuEl\)\[0\]\?\.focus/);
});

test("reduced motion bypasses paced reply animation", () => {
  assert.match(ribbons, /prefers-reduced-motion: reduce/);
  assert.match(ribbons, /!paced \|\| reducedMotion\(\)/);
});
