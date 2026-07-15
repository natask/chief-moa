// Extension-owned microphone capture for MV3.
// The content script owns only page UI; this document owns getUserMedia so the
// mic permission is granted to chrome-extension://..., not to every website.

let activeCapture = null;

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer || 0);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function resampleToPcm16(input, inputRate, outputRate, resample) {
  if (!input?.length || !inputRate || inputRate <= 0) return new ArrayBuffer(0);
  const ratio = inputRate / outputRate;
  const samples = [];
  let index = Math.max(0, Number(resample.offset || 0));
  while (index < input.length) {
    const left = Math.floor(index);
    const right = Math.min(left + 1, input.length - 1);
    const frac = index - left;
    const value = input[left] + (input[right] - input[left]) * frac;
    samples.push(Math.max(-1, Math.min(1, value)));
    index += ratio;
  }
  resample.offset = index - input.length;
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm.buffer;
}

function stopCapture(sessionId = null) {
  const capture = activeCapture;
  if (!capture) return;
  if (sessionId && capture.voiceSessionId !== sessionId) return;
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
  activeCapture = null;
}

async function startCapture(voiceSessionId) {
  if (!voiceSessionId) throw new Error("missing voice session id");
  stopCapture();

  let stream = null;
  let audioCtx = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error("Web Audio is not available in this browser.");

    audioCtx = new AudioContextCtor();
    if (!audioCtx.audioWorklet?.addModule) {
      throw new Error("AudioWorklet microphone capture is not available in this browser.");
    }
    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL("offscreen-audio-worklet.js"));

    const sampleRate = audioCtx.sampleRate;
    const resample = { offset: 0 };
    const source = audioCtx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(audioCtx, "aggie-voice-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const capture = { voiceSessionId, stream, audioCtx, source, worklet, sampleRate, resample };
    activeCapture = capture;

    worklet.port.onmessage = (event) => {
      if (activeCapture !== capture) return;
      const inputSamples = event.data?.samples;
      if (!(inputSamples instanceof Float32Array) || inputSamples.length <= 0) return;
      const pcm = resampleToPcm16(inputSamples, sampleRate, 16000, resample);
      if (pcm.byteLength <= 0) return;
      chrome.runtime
        .sendMessage({
          cmd: "offscreenVoiceAudio",
          voiceSessionId,
          audio: bytesToBase64(pcm),
        })
        .catch(() => {});
    };

    source.connect(worklet);
    worklet.connect(audioCtx.destination);
  } catch (error) {
    for (const track of stream?.getTracks?.() || []) {
      try {
        track.stop();
      } catch {}
    }
    try {
      await audioCtx?.close();
    } catch {}
    if (activeCapture?.voiceSessionId === voiceSessionId) activeCapture = null;
    throw error;
  }
}

// ---- Video note capture -----------------------------------------------------
// Screen recording with mic narration for video notes. The background resolves
// a desktopCapture streamId (picker UI) and hands it here; this document owns
// both getUserMedia calls, records a WebM with MediaRecorder, and uploads the
// blob straight to the gateway so megabytes never ride runtime messages.

let activeVideoCapture = null;
const terminalizingVideoCaptures = new Map();

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
  let capture = activeVideoCapture;
  if ((!capture || (sessionId && capture.videoSessionId !== sessionId)) && sessionId) {
    capture = terminalizingVideoCaptures.get(sessionId) || null;
  }
  if (!capture) return;
  if (sessionId && capture.videoSessionId !== sessionId) return;
  capture.discarded = true;
  capture.acceptingData = false;
  capture.uploadController?.abort();
  if (capture.maxTimer) {
    clearTimeout(capture.maxTimer);
    capture.maxTimer = null;
  }
  try {
    if (capture.recorder && capture.recorder.state !== "inactive") capture.recorder.stop();
  } catch {}
  stopVideoTracks(capture);
  capture.chunks = [];
  capture.totalBytes = 0;
  if (activeVideoCapture === capture) activeVideoCapture = null;
}

async function startVideoCapture({ videoSessionId, streamId, maxMs, maxBytes }) {
  if (!videoSessionId) throw new Error("missing video session id");
  if (!streamId) throw new Error("missing desktop capture stream id");
  if (terminalizingVideoCaptures.has(videoSessionId)) {
    throw new Error("video session is already finishing");
  }
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
      recorderStopped: false,
      acceptingData: true,
      uploadController: null,
    };
    activeVideoCapture = capture;

    recorder.ondataavailable = (event) => {
      // MediaRecorder queues its final dataavailable before stop. Manual stop
      // clears the active slot so another capture can start while this one
      // uploads, but the terminal chunk still belongs to this capture.
      if (capture.discarded || capture.recorderStopped || !capture.acceptingData) return;
      if (!event.data || event.data.size <= 0) return;
      capture.chunks.push(event.data);
      capture.totalBytes += event.data.size;
      if (capture.totalBytes >= capture.maxBytes) {
        capture.capped = true;
        // Stop near the cap, then validate the complete WebM after the required
        // terminal chunk arrives. An oversized recording is rejected whole;
        // byte truncation would corrupt its container.
        if (recorder.state === "recording") {
          try {
            recorder.stop();
          } catch {}
        }
      }
    };
    recorder.onstop = () => {
      if (capture.recorderStopped) return;
      capture.recorderStopped = true;
      capture.acceptingData = false;
      if (capture.maxTimer) {
        clearTimeout(capture.maxTimer);
        capture.maxTimer = null;
      }
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
  if (!capture.recorder || capture.recorderStopped) return Promise.resolve();
  return new Promise((resolve) => {
    capture.stopWaiters.push(resolve);
    try {
      if (capture.recorder.state !== "inactive") capture.recorder.stop();
    } catch {
      capture.stopWaiters = capture.stopWaiters.filter((waiter) => waiter !== resolve);
      resolve();
    }
  });
}

async function stopAndUploadVideoCapture(msg) {
  const capture = activeVideoCapture;
  if (!capture || (msg.videoSessionId && capture.videoSessionId !== msg.videoSessionId)) {
    return { stored: false, error: "No video recording is in progress." };
  }
  terminalizingVideoCaptures.set(capture.videoSessionId, capture);
  activeVideoCapture = null;
  try {
    await waitForVideoRecorderStop(capture);
    if (capture.discarded) {
      return { stored: false, error: "Video recording was discarded." };
    }
    const durationMs = Date.now() - capture.startedAt;
    const blob = new Blob(capture.chunks, { type: capture.recorder?.mimeType || "video/webm" });
    if (blob.size <= 0) {
      return { stored: false, error: "No video was captured." };
    }
    if (blob.size > capture.maxBytes) {
      return {
        stored: false,
        capped: true,
        error: `Video recording exceeded the ${capture.maxBytes}-byte limit and was not uploaded.`,
      };
    }
    if (!msg.gatewayUrl) {
      return { stored: false, error: "No gateway URL set. Open A.G. Options and set the Agent gateway URL." };
    }
    const headers = {
      "content-type": blob.type || "video/webm",
      "x-moa-surface": "agee-extension",
      "x-moa-duration-ms": String(durationMs),
    };
    if (msg.sessionId) headers["x-moa-session-id"] = msg.sessionId;
    if (msg.gatewayToken) headers.authorization = `Bearer ${msg.gatewayToken}`;
    capture.uploadController = new AbortController();
    let resp;
    let text;
    try {
      resp = await fetch(`${msg.gatewayUrl}/v1/video-notes`, {
        method: "POST",
        headers,
        body: blob,
        signal: capture.uploadController.signal,
      });
      text = await resp.text();
    } catch (error) {
      if (capture.discarded) return { stored: false, error: "Video recording was discarded." };
      return { stored: false, error: `Video note upload failed: ${String(error?.message || error)}` };
    }
    if (capture.discarded) return { stored: false, error: "Video recording was discarded." };
    if (!resp.ok) {
      return { stored: false, error: `Video note upload failed (HTTP ${resp.status}): ${text.slice(0, 300)}` };
    }
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {}
    return { stored: true, note: payload?.note || null, durationMs, capped: capture.capped === true };
  } finally {
    capture.acceptingData = false;
    capture.chunks = [];
    capture.totalBytes = 0;
    capture.uploadController = null;
    if (capture.maxTimer) clearTimeout(capture.maxTimer);
    stopVideoTracks(capture);
    if (terminalizingVideoCaptures.get(capture.videoSessionId) === capture) {
      terminalizingVideoCaptures.delete(capture.videoSessionId);
    }
  }
}
// ---- End video note capture -------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
    startCapture(msg.voiceSessionId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        stopCapture(msg.voiceSessionId);
        chrome.runtime
          .sendMessage({
            cmd: "offscreenVoiceError",
            voiceSessionId: msg.voiceSessionId,
            error: String(error?.message || error),
          })
          .catch(() => {});
        sendResponse({ ok: false, error: String(error?.message || error) });
      });
    return true;
  }
  if (msg.cmd === "offscreenVoiceCaptureStop") {
    stopCapture(msg.voiceSessionId || null);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
