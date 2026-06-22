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
    capture.processor?.disconnect();
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

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) throw new Error("Web Audio is not available in this browser.");

  const audioCtx = new AudioContextCtor();
  const sampleRate = audioCtx.sampleRate;
  const resample = { offset: 0 };
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const capture = { voiceSessionId, stream, audioCtx, source, processor, sampleRate, resample };
  activeCapture = capture;

  processor.onaudioprocess = (event) => {
    event.outputBuffer.getChannelData(0).fill(0);
    if (activeCapture !== capture) return;
    const inputSamples = event.inputBuffer.getChannelData(0);
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

  source.connect(processor);
  processor.connect(audioCtx.destination);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
