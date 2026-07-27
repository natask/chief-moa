import assert from "node:assert/strict";
import test from "node:test";
import {
  FILE_ACCESS_INSTRUCTION,
  allowedFileSchemeAccess,
  authorizeBrowserUrl,
} from "../extension/browser-file-access-runtime.js";

test("file URL authorization reports Chrome's user-mediated permission when disabled", async () => {
  const chromeApi = { extension: { isAllowedFileSchemeAccess: (callback) => callback(false) } };
  const result = await authorizeBrowserUrl(chromeApi, "file:///tmp/example.txt");
  assert.equal(result.ok, false);
  assert.equal(result.error, "file_scheme_access_disabled");
  assert.equal(result.instruction, FILE_ACCESS_INSTRUCTION);
  assert.match(result.instruction, /chrome:\/\/extensions/);
  assert.match(result.instruction, /cannot enable/i);
});

test("file URL authorization succeeds only after Chrome reports access", async () => {
  const chromeApi = { extension: { isAllowedFileSchemeAccess: (callback) => callback(true) } };
  assert.deepEqual(await allowedFileSchemeAccess(chromeApi), { allowed: true, supported: true });
  const result = await authorizeBrowserUrl(chromeApi, "file:///tmp/example.txt");
  assert.equal(result.ok, true);
  assert.equal(result.url, "file:///tmp/example.txt");
});

test("authorization preserves web URLs and rejects arbitrary schemes", async () => {
  assert.deepEqual(await authorizeBrowserUrl({}, "https://example.com/a"), { ok: true, url: "https://example.com/a" });
  assert.deepEqual(await authorizeBrowserUrl({}, "javascript:alert(1)"), { ok: false, error: "blocked_url_scheme" });
});
