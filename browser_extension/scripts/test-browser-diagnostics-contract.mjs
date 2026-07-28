import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDiagnosticRequest } from "../extension/browser-diagnostics-contract.js";

test("diagnostic requests bind a tab and cap observation duration and result count", () => {
  assert.deepEqual(normalizeDiagnosticRequest({ tab_id: 42, duration_ms: 999_999, limit: 999 }), {
    tabId: 42,
    durationMs: 2_000,
    limit: 100,
  });
  assert.deepEqual(normalizeDiagnosticRequest({}), { tabId: null, durationMs: 500, limit: 50 });
});
