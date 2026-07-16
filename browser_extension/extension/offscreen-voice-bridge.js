const RECEIVER_ERROR_PATTERN = /receiving end does not exist|could not establish connection|message port closed/i;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingOffscreenReceiver(error) {
  return RECEIVER_ERROR_PATTERN.test(String(error?.message || error || ""));
}

function offscreenRuntimeError(error) {
  const detail = String(error?.message || error || "").trim();
  const suffix = detail ? ` Last error: ${detail}` : "";
  const result = new Error(`offscreen voice receiver unavailable.${suffix}`);
  result.code = "offscreen_runtime_unavailable";
  return result;
}

async function waitForOffscreenReceiver(sendMessage, { attempts = 8, delayMs = 50 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await sendMessage({ cmd: "offscreenVoiceReady" });
      if (response?.ok === true && response?.context === "offscreen") return response;
      lastError = new Error("offscreen document did not acknowledge readiness");
    } catch (error) {
      if (!isMissingOffscreenReceiver(error)) throw error;
      lastError = error;
    }
    if (attempt + 1 < attempts) await delay(delayMs);
  }
  throw offscreenRuntimeError(lastError);
}

async function sendToOffscreenReceiver(sendMessage, ensureReady, message) {
  await ensureReady();
  try {
    return await sendMessage(message);
  } catch (error) {
    if (!isMissingOffscreenReceiver(error)) throw error;
    await ensureReady();
    try {
      return await sendMessage(message);
    } catch (retryError) {
      if (isMissingOffscreenReceiver(retryError)) throw offscreenRuntimeError(retryError);
      throw retryError;
    }
  }
}

export {
  isMissingOffscreenReceiver,
  offscreenRuntimeError,
  sendToOffscreenReceiver,
  waitForOffscreenReceiver,
};
