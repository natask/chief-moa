import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXCLUDED_SOURCE_FILES,
  RUNTIME_SOURCE_FILES,
  validateProductionSourceClassification,
} from "./extension-production-sources.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("every packaged JavaScript file has exactly one production coverage classification", () => {
  const classification = validateProductionSourceClassification(root);
  assert.deepEqual(classification.runtime, [...RUNTIME_SOURCE_FILES]);
  assert.equal(RUNTIME_SOURCE_FILES.length, 30);
  assert.deepEqual(EXCLUDED_SOURCE_FILES, {
    "extension/dev.js": "operational_tooling",
    "extension/vendor/livekit-client.esm.js": "generated_vendor",
  });
});
