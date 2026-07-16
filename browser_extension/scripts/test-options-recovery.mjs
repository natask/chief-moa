import assert from "node:assert/strict";
import {
  MICROPHONE_RECOVERY_TARGET,
  OPTIONS_RECOVERY_STORAGE_KEY,
  createOptionsRecovery,
  normalizeOptionsRecovery,
} from "../extension/options-recovery.js";

const record = createOptionsRecovery(MICROPHONE_RECOVERY_TARGET, "2026-07-16T00:00:00.000Z");
assert.deepEqual(record, {
  version: 1,
  target: "microphone_permission",
  requested_at: "2026-07-16T00:00:00.000Z",
});
assert.equal(OPTIONS_RECOVERY_STORAGE_KEY, "ageeOptionsRecoveryTarget");
assert.deepEqual(normalizeOptionsRecovery(record), record);
assert.equal(createOptionsRecovery("unknown"), null);
assert.equal(normalizeOptionsRecovery(null), null);
assert.equal(normalizeOptionsRecovery({ ...record, version: 2 }), null);
assert.equal(normalizeOptionsRecovery({ ...record, target: "unknown" }), null);

console.log("options recovery tests passed");
