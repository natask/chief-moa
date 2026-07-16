import assert from "node:assert/strict";
import test from "node:test";
import {
  createVoiceStartError,
  microphoneRecoveryFromStartFailure,
  voiceStartFailure,
} from "../extension/voice-start-failure.js";

const permissionRecovery = {
  target: "microphone_permission",
  action_label: "Take me to microphone setup",
};

test("permission denial survives setup error and start-response serialization", () => {
  const error = createVoiceStartError({
    message: "Chrome denied microphone access.",
    code: "microphone_capture_failed",
    failure_code: "microphone_permission_denied",
    recovery: permissionRecovery,
  });
  assert.deepEqual(voiceStartFailure(error), {
    ok: false,
    error: "Chrome denied microphone access.",
    code: "microphone_capture_failed",
    failure_code: "microphone_permission_denied",
    recovery: permissionRecovery,
  });
});

test("runtime-unavailable failures cannot acquire a permission action", () => {
  const failure = voiceStartFailure(Object.assign(new Error("Reload the extension."), {
    code: "offscreen_runtime_unavailable",
    failure_code: "offscreen_runtime_unavailable",
    recovery: permissionRecovery,
  }));
  assert.equal(failure.failure_code, "offscreen_runtime_unavailable");
  assert.equal(failure.recovery, undefined);
  assert.equal(microphoneRecoveryFromStartFailure(failure), null);
});

test("permission recovery must use the packaged microphone target", () => {
  assert.equal(microphoneRecoveryFromStartFailure({
    failure_code: "microphone_permission_denied",
    recovery: { target: "unexpected", action_label: "Go" },
  }), null);
  assert.deepEqual(microphoneRecoveryFromStartFailure({
    failure_code: "microphone_permission_denied",
    recovery: { target: "microphone_permission" },
  }), {
    target: "microphone_permission",
    action_label: "Take me to microphone setup",
  });
});
