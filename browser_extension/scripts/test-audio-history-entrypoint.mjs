import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "extension", "sidepanel.html"), "utf8");
const source = fs.readFileSync(path.join(root, "extension", "sidepanel.js"), "utf8");
const audioSource = source.slice(
  source.indexOf("// ---- Durable audio history"),
  source.indexOf("// One turn at a time."),
);
const contract = JSON.parse(fs.readFileSync(
  path.join(root, "..", "reference", "contracts", "audio-record.v1.schema.json"),
  "utf8",
));

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

test("read-only playback uses the canonical record-provided path", () => {
  assert.match(source, /record\.audio\.playback_href/);
  assert.match(source, /record\.transcript\?\.revisions/);
  assert.doesNotMatch(audioSource, /retranscrib/i);
  assert.doesNotMatch(audioSource, /method:\s*"POST"/);
  assert.match(source, /record\.media_status !== "available"/);
  assert.match(source, /revision\.provenance/);
  assert.equal(contract.properties.contract.const, "audio_record.v1");
  assert.deepEqual(contract.properties.media_status.enum, [
    "available", "missing", "deleted", "incognito", "tombstone",
  ]);
});
