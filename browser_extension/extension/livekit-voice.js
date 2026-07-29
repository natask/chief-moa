// Background-side helper for the flag-gated LiveKit voice prototype.
//
// Off by default. When the "LiveKit voice (experimental)" setting is on, the
// voice-start path asks the gateway to mint a LiveKit room token
// (POST /v1/voice/livekit/token), opens the LiveKit offscreen document
// (offscreen-livekit.html, WebRTC), and relays the offscreen document's
// agent-state / error events to the page overlay. Any failure throws so the
// caller can fall back to the default WS voice path with a visible notice.
//
// Clients still hold only a gateway URL + token; a room token is the same
// short-lived credential posture as the browser voice ticket.

export const LIVEKIT_VOICE_FLAG_KEY = "ageeLivekitVoiceEnabled";
const OFFSCREEN_LIVEKIT_DOCUMENT = "offscreen-livekit.html";

// id -> { tabId, cueId } so offscreen events route back to the owning tab.
const livekitSessions = new Map();
let offscreenEventListenerBound = false;

export async function isLivekitVoiceEnabled() {
  try {
    const stored = await chrome.storage.local.get({ [LIVEKIT_VOICE_FLAG_KEY]: false });
    return stored[LIVEKIT_VOICE_FLAG_KEY] === true;
  } catch {
    return false;
  }
}

// Start an experimental LiveKit voice session. Resolves to a session handle with
// a voiceSessionId (so the caller can treat it like the WS path) or throws.
export async function startLivekitVoiceSession({ tabId, cueId, gatewayUrl, gatewayToken, sessionId, deviceId }) {
  bindOffscreenEventListener();
  const id = `lkv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const minted = await mintRoomToken({ gatewayUrl, gatewayToken, sessionId, deviceId });
  await ensureOffscreenLivekitDocument();
  livekitSessions.set(id, { tabId, cueId });
  const response = await chrome.runtime.sendMessage({
    cmd: "livekitConnect",
    id,
    url: minted.url,
    token: minted.token,
  });
  if (!response?.ok) {
    livekitSessions.delete(id);
    throw new Error(response?.error || "LiveKit offscreen connect failed");
  }
  return { voiceSessionId: id, livekit: true, room: minted.room };
}

export async function closeLivekitVoiceSession(id) {
  if (id) {
    livekitSessions.delete(id);
  }
  await chrome.runtime.sendMessage({ cmd: "livekitDisconnect", id: id || null }).catch(() => {});
  await closeOffscreenLivekitDocument();
}

async function mintRoomToken({ gatewayUrl, gatewayToken, sessionId, deviceId }) {
  const base = String(gatewayUrl || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error("gateway URL is not configured for LiveKit voice");
  }
  const headers = { "content-type": "application/json" };
  if (gatewayToken) {
    headers.authorization = `Bearer ${gatewayToken}`;
  }
  const response = await fetch(`${base}/v1/voice/livekit/token`, {
    method: "POST",
    headers,
    body: JSON.stringify({ session_id: sessionId, device_id: deviceId, surface: "agee-extension" }),
  });
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (response.status === 503) {
    throw new Error(`LiveKit is not configured on the gateway (${data.reason || "not_configured"})`);
  }
  if (!response.ok || !data.url || !data.token) {
    throw new Error(`gateway did not mint a LiveKit token (${response.status})`);
  }
  return { url: data.url, token: data.token, room: data.room || "" };
}

// Chrome allows only one offscreen document per extension, so the WS voice
// document (offscreen.html, USER_MEDIA) is closed before opening the WebRTC one.
// The WS path recreates its own document when it next needs the microphone.
async function ensureOffscreenLivekitDocument() {
  if (!chrome?.offscreen?.createDocument) {
    throw new Error("Extension WebRTC is not supported in this Chrome build.");
  }
  await closeAnyOffscreenDocument();
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_LIVEKIT_DOCUMENT,
    reasons: ["USER_MEDIA", "WEB_RTC"],
    justification: "Ag captures microphone audio and runs a WebRTC session to the configured LiveKit voice transport (experimental).",
  });
}

async function closeOffscreenLivekitDocument() {
  await closeAnyOffscreenDocument();
}

async function closeAnyOffscreenDocument() {
  if (!chrome?.offscreen?.closeDocument) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // No document open, or it was already closed — both are fine.
  }
}

// Relay offscreen agent-state / error events to the owning tab as the same
// overlay signals the WS path uses (setAgentState + a visible notice).
function bindOffscreenEventListener() {
  if (offscreenEventListenerBound) return;
  offscreenEventListenerBound = true;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.cmd !== "livekitOffscreenEvent") return false;
    const session = livekitSessions.get(msg.id);
    if (!session) return false;
    if (msg.kind === "state" && msg.state) {
      chrome.tabs.sendMessage(session.tabId, { cmd: "livekitAgentState", state: msg.state }).catch(() => {});
    } else if (msg.kind === "error") {
      chrome.tabs.sendMessage(session.tabId, {
        cmd: "livekitNotice",
        cueId: session.cueId || null,
        text: `LiveKit voice error: ${String(msg.message || "unknown")}`,
      }).catch(() => {});
    } else if (msg.kind === "disconnected") {
      livekitSessions.delete(msg.id);
    }
    return false;
  });
}
