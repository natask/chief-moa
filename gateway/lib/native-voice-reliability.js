"use strict";

function nativeEmptyResponseError(provider) {
  const error = new Error(`${provider || "native voice provider"} completed without assistant text or audio`);
  error.name = "RetryableVoiceProviderError";
  error.code = "native_provider_empty_response";
  error.retryable = true;
  return error;
}

function createInactivityTimer(timeoutMs, onTimeout) {
  const delayMs = Math.max(1, Number(timeoutMs) || 1);
  let timer = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const touch = () => {
    cancel();
    timer = setTimeout(onTimeout, delayMs);
    timer.unref?.();
  };
  touch();
  return { touch, cancel };
}

module.exports = { createInactivityTimer, nativeEmptyResponseError };
