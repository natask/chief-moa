const OPTIONS_RECOVERY_VERSION = 1;
const OPTIONS_RECOVERY_STORAGE_KEY = "ageeOptionsRecoveryTarget";
const MICROPHONE_RECOVERY_TARGET = "microphone_permission";
const OPTIONS_RECOVERY_TARGETS = new Set([MICROPHONE_RECOVERY_TARGET]);

function createOptionsRecovery(target, requestedAt = new Date().toISOString()) {
  if (!OPTIONS_RECOVERY_TARGETS.has(target)) return null;
  return {
    version: OPTIONS_RECOVERY_VERSION,
    target,
    requested_at: String(requestedAt || ""),
  };
}

function normalizeOptionsRecovery(value) {
  if (!value || typeof value !== "object") return null;
  if (value.version !== OPTIONS_RECOVERY_VERSION) return null;
  if (!OPTIONS_RECOVERY_TARGETS.has(value.target)) return null;
  return createOptionsRecovery(value.target, value.requested_at);
}

export {
  MICROPHONE_RECOVERY_TARGET,
  OPTIONS_RECOVERY_STORAGE_KEY,
  createOptionsRecovery,
  normalizeOptionsRecovery,
};
