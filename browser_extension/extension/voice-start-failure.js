const MICROPHONE_PERMISSION_FAILURE = "microphone_permission_denied";
const MICROPHONE_RECOVERY_TARGET = "microphone_permission";

function microphoneRecoveryFromStartFailure(failure) {
  if (String(failure?.failure_code || "") !== MICROPHONE_PERMISSION_FAILURE) return null;
  if (failure?.recovery?.target !== MICROPHONE_RECOVERY_TARGET) return null;
  return {
    target: MICROPHONE_RECOVERY_TARGET,
    action_label: String(failure.recovery.action_label || "Take me to microphone setup"),
  };
}

function voiceStartFailure(error) {
  const failureCode = String(error?.failure_code || error?.code || "").trim();
  const code = String(error?.code || "").trim();
  const recovery = microphoneRecoveryFromStartFailure({
    failure_code: failureCode,
    recovery: error?.recovery,
  });
  return {
    ok: false,
    error: String(error?.message || error || "Could not start voice."),
    ...(code ? { code } : {}),
    ...(failureCode ? { failure_code: failureCode } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

function createVoiceStartError(failure, fallbackMessage = "Voice session closed during setup.") {
  const error = new Error(String(failure?.message || failure?.error || fallbackMessage));
  if (failure?.code) error.code = String(failure.code);
  if (failure?.failure_code) error.failure_code = String(failure.failure_code);
  const recovery = microphoneRecoveryFromStartFailure(failure);
  if (recovery) error.recovery = recovery;
  return error;
}

function preOpenVoiceStartError(session, fallbackMessage) {
  return createVoiceStartError(session?.setupFailure, fallbackMessage);
}

export {
  MICROPHONE_PERMISSION_FAILURE,
  MICROPHONE_RECOVERY_TARGET,
  createVoiceStartError,
  microphoneRecoveryFromStartFailure,
  preOpenVoiceStartError,
  voiceStartFailure,
};
