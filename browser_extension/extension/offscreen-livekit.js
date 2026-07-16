// Offscreen WebRTC document for the flag-gated LiveKit voice prototype.
//
// Owns the LiveKit Room: extension-origin microphone capture (published with the
// pre-connect audio buffer so the start of the utterance is not clipped),
// subscription + playback of the agent's reply audio, and the lk.agent.state
// participant attribute (thinking/speaking) that the agents worker publishes for
// free. It reports state and errors back to the background service worker, which
// relays them to the page overlay. This runs ONLY when the "LiveKit voice
// (experimental)" setting is on; the default WS voice path uses offscreen.js.
//
// livekit-client is vendored locally (Chrome MV3 forbids remote code in
// privileged contexts). Exact option names (pre-connect buffer, agent-state
// attribute) are pinned to livekit-client 2.20.0 and are part of what the spike
// validates against a live LiveKit Cloud room.

import {
  Room,
  RoomEvent,
} from "./vendor/livekit-client.esm.js";

const AGENT_STATE_ATTR = "lk.agent.state";

let room = null;
let activeId = "";
let audioEl = null;

function post(event) {
  // Fire-and-forget back to the background worker; it routes to the owning tab.
  chrome.runtime.sendMessage({ cmd: "livekitOffscreenEvent", ...event }).catch(() => {});
}

function mapAgentState(raw) {
  const state = String(raw || "").toLowerCase();
  if (state === "thinking" || state === "initializing") return "thinking";
  if (state === "speaking") return "speaking";
  // listening / idle / unknown -> let the overlay show its resting state.
  return "listening";
}

function ensureAudioElement() {
  if (audioEl) return audioEl;
  audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  document.body.appendChild(audioEl);
  return audioEl;
}

async function connect({ id, url, token }, RoomCtor = Room) {
  await teardown();
  activeId = id;
  room = new RoomCtor({ adaptiveStream: true, dynacast: true });

  room.on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => {
    const attrs = participant?.attributes || {};
    if (Object.prototype.hasOwnProperty.call(attrs, AGENT_STATE_ATTR)) {
      post({ id: activeId, kind: "state", state: mapAgentState(attrs[AGENT_STATE_ATTR]) });
    }
  });

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === "audio") {
      track.attach(ensureAudioElement());
      post({ id: activeId, kind: "state", state: "speaking" });
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    post({ id: activeId, kind: "disconnected" });
  });

  // Pre-connect audio buffer: enabling the mic before connect buffers the first
  // audio locally and flushes it once the room is joined, so the leading words
  // are not dropped (one of the two features this spike measures).
  await room.localParticipant.setMicrophoneEnabled(true, { preConnectBuffer: true });
  await room.connect(url, token);
  post({ id: activeId, kind: "connected" });
}

async function teardown() {
  if (room) {
    try {
      await room.disconnect();
    } catch {
      // ignore teardown errors
    }
    room = null;
  }
  if (audioEl) {
    try {
      audioEl.srcObject = null;
      audioEl.remove();
    } catch {
      // ignore
    }
    audioEl = null;
  }
  activeId = "";
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.cmd === "livekitConnect") {
    connect({ id: msg.id, url: msg.url, token: msg.token })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        post({ id: msg.id, kind: "error", message: String(error?.message || error) });
        sendResponse({ ok: false, error: String(error?.message || error) });
      });
    return true;
  }
  if (msg?.cmd === "livekitDisconnect") {
    teardown()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

export { connect, ensureAudioElement, mapAgentState, post, teardown };
