import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "extension", "sidepanel.html"), "utf8");
const source = fs.readFileSync(path.join(root, "extension", "sidepanel.js"), "utf8");

test("side panel exposes an explicit, extension-owned audio History entry point", () => {
  assert.match(html, /id="audioHistoryBtn"/);
  assert.match(html, /aria-controls="audioHistoryPanel"/);
  assert.match(html, /id="audioHistoryPanel"[^>]*hidden/);
  assert.match(source, /\/v1\/audio-history\?limit=100/);
});

test("audio history remains authenticated and never redirects tokens into a web URL", () => {
  assert.match(source, /authorization: `Bearer \$\{config\.gatewayToken\}`/);
  assert.match(source, /cache: "no-store"/);
  assert.doesNotMatch(source, /agee\.app\/history\?[^"'`]*token/i);
});

test("playback and retranscription use canonical record-provided paths", () => {
  assert.match(source, /record\.audio\.playback_href/);
  assert.match(source, /record\.retranscribe_href/);
  assert.match(source, /The original transcript will remain available/);
  assert.match(source, /record\.transcript\?\.revisions/);
});
