import { micLevelMessage } from "./offscreen-voice-bridge.js";
import { createPcm16Resampler } from "./offscreen-audio-resampler.js";
import { createVoicePreRollBuffer } from "./voice-preroll-buffer.js";
import { finalizeActiveVideoCapture } from "./video-capture-finalization.js";

// Extension-owned microphone capture for MV3.
// The content script owns only page UI; this document owns getUserMedia so the
// mic permission is granted to chrome-extension://..., not to every website.

let activeCapture = null;
let captureOperation = Promise.resolve();
const VOICE_PRE_ROLL_BYTES = 16000 * 2 * 500 / 1000;
const VOICE_WARM_CAPTURE_TIMEOUT_MS = 2000;

function captureFailure(error, stage) {
  const message = String(error?.message || error || "microphone capture failed");
  const failure = new Error(message);
  const name = String(error?.name || "");
  failure.code = stage === "user_media" && ["NotAllowedError", "SecurityError"].includes(name)
    ? "microphone_permission_denied"
    : "microphone_capture_failed";
  return failure;
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer || 0);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function createVoiceAudioContext(AudioContextCtor) {
  try {
    return new AudioContextCtor({ latencyHint: "interactive", sampleRate: 16000 });
  } catch {
    return new AudioContextCtor({ latencyHint: "interactive" });
  }
}

function stopCapture(sessionId = null) {
  const capture = activeCapture;
  if (!capture) return;
  if (sessionId && capture.captureId !== sessionId) return;
  try {
    capture.worklet?.port?.close?.();
  } catch {}
  try {
    capture.worklet?.disconnect();
  } catch {}
  try {
    capture.source?.disconnect();
  } catch {}
  for (const track of capture.stream?.getTracks?.() || []) {
    try {
      track.stop();
    } catch {}
  }
  try {
    capture.audioCtx?.close();
  } catch {}
  if (capture.warmTimeout) clearTimeout(capture.warmTimeout);
  activeCapture = null;
}

function enqueueCaptureOperation(operation) {
  const next = captureOperation.catch(() => {}).then(operation);
  captureOperation = next.catch(() => {});
  return next;
}

async function microphonePermissionGranted() {
  if (!navigator.permissions?.query) return false;
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    return status?.state === "granted";
  } catch {
    return false;
  }
}

function forwardCaptureAudio(capture, pcm) {
  if (!pcm?.byteLength || activeCapture !== capture) return;
  if (capture.warming) {
    capture.preRoll.append(new Uint8Array(pcm));
    return;
  }
  chrome.runtime
    .sendMessage({
      cmd: "offscreenVoiceAudio",
      voiceSessionId: capture.captureId,
      audio: bytesToBase64(pcm),
    })
    .catch(() => {});
}

function forwardCaptureLevel(capture, level) {
  const message = micLevelMessage(capture?.captureId, level);
  if (!message || activeCapture !== capture) return;
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function startCapture(captureId, { warming = false } = {}) {
  if (!captureId) throw new Error("missing voice capture id");
  stopCapture();

  let stream = null;
  let audioCtx = null;
  let stage = "user_media";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        // Browser speech enhancement can smear unfamiliar consonants and
        // acronyms. Preserve the mic signal; retain echo cancellation because
        // assistant audio may still be playing through the speakers.
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    stage = "audio_runtime";
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error("Web Audio is not available in this browser.");

    audioCtx = createVoiceAudioContext(AudioContextCtor);
    if (!audioCtx.audioWorklet?.addModule) {
      throw new Error("AudioWorklet microphone capture is not available in this browser.");
    }
    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL("offscreen-audio-worklet.js"));

    const sampleRate = audioCtx.sampleRate;
    const resampler = createPcm16Resampler(sampleRate, 16000);
    const source = audioCtx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(audioCtx, "aggie-voice-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const capture = {
      captureId,
      warming,
      preRoll: createVoicePreRollBuffer(VOICE_PRE_ROLL_BYTES),
      stream,
      audioCtx,
      source,
      worklet,
      sampleRate,
      resampler,
    };
    activeCapture = capture;
    if (warming) {
      capture.warmTimeout = setTimeout(() => stopCapture(capture.captureId), VOICE_WARM_CAPTURE_TIMEOUT_MS);
    }

    worklet.port.onmessage = (event) => {
      if (activeCapture !== capture) return;
      // A warming capture is a permission/latency trick with no turn behind it,
      // so its levels have nowhere to go and nothing to paint.
      if (event.data?.level !== undefined) {
        if (!capture.warming) forwardCaptureLevel(capture, event.data.level);
        return;
      }
      const inputSamples = event.data?.samples;
      if (!(inputSamples instanceof Float32Array) || inputSamples.length <= 0) return;
      const pcm = resampler.process(inputSamples);
      if (pcm.byteLength <= 0) return;
      forwardCaptureAudio(capture, pcm);
    };

    source.connect(worklet);
    worklet.connect(audioCtx.destination);
    const settings = stream.getAudioTracks?.()[0]?.getSettings?.() || {};
    return {
      inputSampleRate: sampleRate,
      outputSampleRate: 16000,
      echoCancellation: settings.echoCancellation === true,
      noiseSuppression: settings.noiseSuppression === true,
      autoGainControl: settings.autoGainControl === true,
    };
  } catch (error) {
    for (const track of stream?.getTracks?.() || []) {
      try {
        track.stop();
      } catch {}
    }
    try {
      await audioCtx?.close();
    } catch {}
    if (activeCapture?.captureId === captureId) activeCapture = null;
    throw captureFailure(error, stage);
  }
}

async function warmCapture(warmCaptureId) {
  if (!warmCaptureId) throw new Error("missing warm capture id");
  if (activeCapture?.captureId === warmCaptureId && activeCapture.warming) {
    return { warmed: true, preRollBytes: activeCapture.preRoll.byteLength };
  }
  // Gesture warm-up must never create an unsolicited permission prompt when a
  // normal mascot click resolves to text. The explicit voice/record start path
  // retains the existing visible permission recovery behavior.
  if (!(await microphonePermissionGranted())) {
    return { warmed: false, reason: "microphone_permission_not_granted" };
  }
  if (activeCapture && !activeCapture.warming) {
    return { warmed: false, reason: "capture_active" };
  }
  await startCapture(warmCaptureId, { warming: true });
  return { warmed: true, preRollBytes: 0 };
}

async function promoteOrStartCapture(captureId, warmCaptureId = null) {
  const capture = activeCapture;
  if (capture?.warming && warmCaptureId && capture.captureId === warmCaptureId) {
    if (capture.warmTimeout) clearTimeout(capture.warmTimeout);
    capture.warmTimeout = null;
    capture.captureId = captureId;
    capture.warming = false;
    const preRoll = capture.preRoll.drain();
    forwardCaptureAudio(capture, preRoll);
    return {
      inputSampleRate: capture.sampleRate,
      outputSampleRate: 16000,
      adoptedPreRollBytes: preRoll.byteLength,
    };
  }
  return startCapture(captureId);
}

// ---- Video note capture -----------------------------------------------------
// Screen recording with mic narration for video notes. The background resolves
// a desktopCapture streamId (picker UI) and hands it here; this document owns
// both getUserMedia calls, records a WebM with MediaRecorder, and uploads the
// blob straight to the gateway so megabytes never ride runtime messages.

let activeVideoCapture = null;

function pickVideoMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const candidate of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(candidate)) return candidate;
  }
  return "";
}

function stopVideoTracks(capture) {
  for (const stream of [capture?.screenStream, capture?.micStream]) {
    for (const track of stream?.getTracks?.() || []) {
      try {
        track.stop();
      } catch {}
    }
  }
}

function discardVideoCapture(sessionId = null) {
  const capture = activeVideoCapture;
  if (!capture) return;
  if (sessionId && capture.videoSessionId !== sessionId) return;
  capture.discarded = true;
  if (capture.maxTimer) clearTimeout(capture.maxTimer);
  try {
    if (capture.recorder && capture.recorder.state !== "inactive") capture.recorder.stop();
  } catch {}
  stopVideoTracks(capture);
  capture.chunks = [];
  activeVideoCapture = null;
}

async function startVideoCapture({ videoSessionId, streamId, maxMs, maxBytes }) {
  if (!videoSessionId) throw new Error("missing video session id");
  if (!streamId) throw new Error("missing desktop capture stream id");
  discardVideoCapture();

  let screenStream = null;
  let micStream = null;
  try {
    screenStream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: streamId,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 10,
        },
      },
    });
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const combined = new MediaStream([
      ...screenStream.getVideoTracks(),
      ...micStream.getAudioTracks(),
    ]);
    const mimeType = pickVideoMimeType();
    // Low bitrate on purpose: screen content compresses well at 10fps, and the
    // blob must stay under the gateway's inline-video cap.
    const recorder = new MediaRecorder(combined, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 800_000,
      audioBitsPerSecond: 32_000,
    });

    const capture = {
      videoSessionId,
      recorder,
      screenStream,
      micStream,
      chunks: [],
      totalBytes: 0,
      capped: false,
      discarded: false,
      startedAt: Date.now(),
      maxBytes: Number(maxBytes) > 0 ? Number(maxBytes) : 20 * 1024 * 1024,
      maxTimer: null,
      stopWaiters: [],
    };
    activeVideoCapture = capture;

    recorder.ondataavailable = (event) => {
      if (activeVideoCapture !== capture || capture.discarded) return;
      if (!event.data || event.data.size <= 0) return;
      capture.chunks.push(event.data);
      capture.totalBytes += event.data.size;
      if (capture.totalBytes >= capture.maxBytes && recorder.state === "recording") {
        // Size cap reached: finish the recording with what we have. The user's
        // stop click will find the recorder already stopped and just upload.
        capture.capped = true;
        try {
          recorder.stop();
        } catch {}
      }
    };
    recorder.onstop = () => {
      if (capture.maxTimer) clearTimeout(capture.maxTimer);
      stopVideoTracks(capture);
      for (const resolve of capture.stopWaiters.splice(0)) resolve();
    };

    // The user can end capture from Chrome's own "Stop sharing" bar; treat it
    // like a stop press so the note still uploads.
    const videoTrack = screenStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener("ended", () => {
        if (activeVideoCapture !== capture || capture.discarded) return;
        chrome.runtime
          .sendMessage({ cmd: "offscreenVideoEnded", videoSessionId })
          .catch(() => {});
      });
    }

    const cappedMs = Number(maxMs) > 0 ? Number(maxMs) : 120_000;
    capture.maxTimer = setTimeout(() => {
      if (activeVideoCapture !== capture || capture.discarded) return;
      capture.capped = true;
      try {
        if (recorder.state === "recording") recorder.stop();
      } catch {}
      chrome.runtime
        .sendMessage({ cmd: "offscreenVideoEnded", videoSessionId })
        .catch(() => {});
    }, cappedMs);

    recorder.start(1000);
  } catch (error) {
    stopVideoTracks({ screenStream, micStream });
    if (activeVideoCapture?.videoSessionId === videoSessionId) activeVideoCapture = null;
    throw error;
  }
}

function waitForVideoRecorderStop(capture) {
  if (!capture.recorder || capture.recorder.state === "inactive") return Promise.resolve();
  return new Promise((resolve) => {
    capture.stopWaiters.push(resolve);
    try {
      if (capture.recorder.state !== "inactive") capture.recorder.stop();
    } catch {
      resolve();
    }
  });
}

async function stopAndUploadVideoCapture(msg) {
  const capture = activeVideoCapture;
  if (!capture || (msg.videoSessionId && capture.videoSessionId !== msg.videoSessionId)) {
    return { stored: false, error: "No video recording is in progress." };
  }
  // Keep this capture active through MediaRecorder.onstop. The terminal
  // dataavailable event can arrive only after stop() is requested, and the
  // handler intentionally accepts chunks only from the active capture.
  await finalizeActiveVideoCapture({
    capture,
    getActiveCapture: () => activeVideoCapture,
    clearActiveCapture: () => { activeVideoCapture = null; },
    stopRecorder: waitForVideoRecorderStop,
  });
  const durationMs = Date.now() - capture.startedAt;
  const blob = new Blob(capture.chunks, { type: capture.recorder?.mimeType || "video/webm" });
  capture.chunks = [];
  if (blob.size <= 0) {
    return { stored: false, error: "No video was captured." };
  }
  if (!msg.gatewayUrl) {
    return { stored: false, error: "No gateway URL set. Open AG Options and set the Agent gateway URL." };
  }
  const headers = {
    "content-type": blob.type || "video/webm",
    "x-moa-surface": "agee-extension",
    "x-moa-duration-ms": String(durationMs),
    "x-moa-retention": "user_kept",
  };
  if (msg.sessionId) headers["x-moa-session-id"] = msg.sessionId;
  if (msg.gatewayToken) headers.authorization = `Bearer ${msg.gatewayToken}`;
  let resp;
  try {
    resp = await fetch(`${msg.gatewayUrl}/v1/video-notes`, { method: "POST", headers, body: blob });
  } catch (error) {
    return { stored: false, error: `Video note upload failed: ${String(error?.message || error)}` };
  }
  const text = await resp.text();
  if (!resp.ok) {
    return { stored: false, error: `Video note upload failed (HTTP ${resp.status}): ${text.slice(0, 300)}` };
  }
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}
  return { stored: true, note: payload?.note || null, durationMs, capped: capture.capped === true };
}
// ---- End video note capture -------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.cmd === "offscreenVoiceReady") {
    sendResponse({ ok: true, context: "offscreen" });
    return true;
  }
  if (msg.cmd === "offscreenVoiceCaptureStatus") {
    sendResponse({
      ok: true,
      active: Boolean(activeCapture),
      voiceSessionId: activeCapture?.captureId || null,
      warming: activeCapture?.warming === true,
    });
    return true;
  }
  if (msg.cmd === "offscreenClipboardWrite") {
    const text = String(msg.text || "");
    if (!text) {
      sendResponse({ ok: false, error: "clipboard text is empty" });
      return true;
    }
    Promise.resolve().then(() => {
      if (!navigator.clipboard?.writeText) throw new Error("offscreen clipboard API is unavailable");
      return navigator.clipboard.writeText(text);
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "offscreenVideoCaptureStart") {
    startVideoCapture(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "offscreenVideoCaptureStop") {
    stopAndUploadVideoCapture(msg)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ stored: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "offscreenVideoCaptureDiscard") {
    discardVideoCapture(msg.videoSessionId || null);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.cmd === "offscreenVoiceCaptureStart") {
    enqueueCaptureOperation(() => promoteOrStartCapture(msg.voiceSessionId, msg.warmCaptureId || null))
      .then((capture) => sendResponse({ ok: true, capture }))
      .catch((error) => {
        stopCapture(msg.voiceSessionId);
        chrome.runtime
          .sendMessage({
            cmd: "offscreenVoiceError",
            voiceSessionId: msg.voiceSessionId,
            error: String(error?.message || error),
            code: error?.code || "microphone_capture_failed",
          })
          .catch(() => {});
        sendResponse({ ok: false, error: String(error?.message || error), code: error?.code || "microphone_capture_failed" });
      });
    return true;
  }
  if (msg.cmd === "offscreenVoiceCaptureWarm") {
    enqueueCaptureOperation(() => warmCapture(msg.warmCaptureId))
      .then((capture) => sendResponse({ ok: true, capture }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error), code: error?.code || "microphone_capture_failed" }));
    return true;
  }
  if (msg.cmd === "offscreenVoiceCaptureStop") {
    enqueueCaptureOperation(() => stopCapture(msg.voiceSessionId || null))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
