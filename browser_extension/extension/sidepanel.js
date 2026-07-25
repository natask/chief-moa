// A.G. side panel — the extension-owned agent surface. Runs as an extension
// page so it renders on every tab (chrome:// pages included) and persists
// across tab switches. All gateway traffic goes through the background service
// worker over a long-lived port; mic capture happens in the background's
// offscreen document, never here (extension pages cannot render the
// getUserMedia permission prompt).

import { getEffectiveGatewayConfig } from "./config.js";
import { createDeviceCredentialRuntime } from "./device-credential-runtime.js";
import {
  buildAssignmentRequest,
  buildFallbackRequest,
  buildFeedbackRequest,
  deriveReleaseCockpitState,
  parseAssignmentMutationResponse,
  parseReleaseControlView,
} from "./release-control-runtime.js";

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const historyEl = document.getElementById("history");
const historyErrorEl = document.getElementById("historyError");
const historyErrorTextEl = document.getElementById("historyErrorText");
const historyRetryBtn = document.getElementById("historyRetry");
const talkBtn = document.getElementById("talk");
const form = document.getElementById("form");
const textInput = document.getElementById("text");
const sendBtn = document.getElementById("sendBtn");
const audioHistoryBtn = document.getElementById("audioHistoryBtn");
const audioHistoryPanel = document.getElementById("audioHistoryPanel");
const audioHistoryRefreshBtn = document.getElementById("audioHistoryRefresh");
const audioHistoryStatusEl = document.getElementById("audioHistoryStatus");
const audioHistoryListEl = document.getElementById("audioHistoryList");

const TURN_WATCHDOG_MS = 90000;

let port = null;
let nextReqId = 1;
const pending = new Map();
let reconnectTimer = null;
let reconnectAttempt = 0;
let historyRefresh = null;
let historyRefreshGeneration = 0;
let audioHistoryBusy = false;
let nativeAudio = null;

let audioCtx = null;
let playbackTime = 0;
let playbackRate = 1;
const playbackSources = new Set();

// ---- Release cockpit -------------------------------------------------------

const releaseRefreshBtn = document.getElementById("releaseRefresh");
const releaseErrorEl = document.getElementById("releaseError");
const releaseNoticeEl = document.getElementById("releaseNotice");
const releaseContentEl = document.getElementById("releaseContent");
const releaseCardsEl = document.getElementById("releaseCards");
const releaseCandidateEl = document.getElementById("releaseCandidate");
const releaseAssignBtn = document.getElementById("releaseAssign");
const releaseFallbackBtn = document.getElementById("releaseFallback");
const releaseFeedbackForm = document.getElementById("releaseFeedbackForm");
const releaseFeedbackBindingEl = document.getElementById("releaseFeedbackBinding");
const releaseFeedbackTextEl = document.getElementById("releaseFeedbackText");
const releaseFeedbackSubmitBtn = document.getElementById("releaseFeedbackSubmit");
const RELEASE_CONTROL_BASE = "/v1/release-control/apps/chief-moa";
const releaseDeviceCredentials = createDeviceCredentialRuntime({
  storage: {
    get: (key) => chrome.storage.local.get(key),
    set: (key, value) => chrome.storage.local.set({ [key]: value }),
  },
});

let releaseView = null;
let releaseDeviceId = "";
let releaseBusy = false;
let releaseFeedbackEligible = false;

async function stableReleaseDeviceId() {
  const stored = await chrome.storage.local.get("ageeDeviceId");
  if (stored.ageeDeviceId) return String(stored.ageeDeviceId);
  const deviceId = `browser_${crypto.randomUUID().replaceAll("-", "")}`;
  await chrome.storage.local.set({ ageeDeviceId: deviceId });
  return deviceId;
}

function releaseNonce() {
  return crypto.randomUUID();
}

function showReleaseError(message) {
  releaseErrorEl.textContent = String(message || "Release control is unavailable.");
  releaseErrorEl.hidden = false;
  releaseContentEl.hidden = true;
}

function clearReleaseError() {
  releaseErrorEl.hidden = true;
  releaseErrorEl.textContent = "";
}

function showReleaseNotice(message) {
  releaseNoticeEl.textContent = String(message || "");
  releaseNoticeEl.hidden = !message;
}

function setReleaseBusy(busy) {
  releaseBusy = busy;
  releaseRefreshBtn.disabled = busy;
  releaseCandidateEl.disabled = busy;
  releaseAssignBtn.disabled = busy;
  releaseFallbackBtn.disabled = busy;
  releaseFeedbackTextEl.disabled = busy || !releaseFeedbackEligible;
  releaseFeedbackSubmitBtn.disabled = busy || !releaseFeedbackEligible;
}

async function releaseControlRequest(path, { method = "GET", body = null } = {}) {
  const config = await getEffectiveGatewayConfig();
  if (!config.gatewayUrl) throw new Error("Release control is unavailable because no gateway origin is configured.");
  const gatewayOrigin = new URL(config.gatewayUrl);
  const loopback = gatewayOrigin.hostname === "localhost"
    || gatewayOrigin.hostname === "127.0.0.1"
    || gatewayOrigin.hostname === "[::1]";
  if (gatewayOrigin.protocol !== "https:" && !(gatewayOrigin.protocol === "http:" && loopback)) {
    throw new Error("Release control requires HTTPS, except for an explicit loopback development gateway.");
  }
  releaseDeviceId ||= await stableReleaseDeviceId();
  let response;
  try {
    response = await releaseDeviceCredentials.request({
      gatewayUrl: config.gatewayUrl,
      gatewayToken: config.gatewayToken,
      deviceId: releaseDeviceId,
      surfaceId: "browser_extension",
      path: `${RELEASE_CONTROL_BASE}${path}`,
      method,
      body,
    });
  } catch (error) {
    throw new Error(`Release control could not reach the configured gateway: ${String(error?.message || error)}`);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Release control returned ${response.status} without a JSON response.`);
  }
  if (!response.ok) {
    const detail = String(payload?.message || payload?.error || `HTTP ${response.status}`);
    if (response.status === 404) throw new Error("This gateway does not expose the release-control API yet (404).");
    throw new Error(`Release control rejected the request (${response.status}): ${detail}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Release control returned an invalid response.");
  }
  return payload;
}

function readinessLabel(readiness) {
  if (typeof readiness.status === "string") return readiness.status;
  if (typeof readiness.ready === "boolean") return readiness.ready ? "ready" : "blocked";
  return JSON.stringify(readiness);
}

function addReleaseCard(label, candidate, current) {
  const card = document.createElement("article");
  card.className = "release-card";
  card.dataset.current = String(Boolean(candidate && current
    && candidate.bundle_id === current.bundle_id && candidate.release_id === current.release_id));
  const title = document.createElement("div");
  title.className = "release-card-title";
  title.textContent = label;
  const value = document.createElement("div");
  value.className = "release-card-value";
  value.textContent = candidate ? `${candidate.release_id}\n${candidate.artifact.sha256}` : "Unavailable";
  card.append(title, value);
  if (candidate) {
    const meta = document.createElement("div");
    meta.className = "release-card-meta";
    meta.textContent = `v${candidate.artifact.version} · ${readinessLabel(candidate.readiness)}`;
    card.appendChild(meta);
  }
  releaseCardsEl.appendChild(card);
}

function renderReleaseCockpit(view) {
  const manifestVersion = chrome.runtime.getManifest().version;
  const state = deriveReleaseCockpitState(view, manifestVersion);
  releaseCardsEl.replaceChildren();
  addReleaseCard("Current assignment", state.current, state.current);
  addReleaseCard("Stable", state.stable, state.current);
  addReleaseCard("Preview", state.preview, state.current);

  const options = document.createDocumentFragment();
  for (const candidate of view.candidates) {
    const option = document.createElement("option");
    option.value = `${candidate.bundle_id}\u0000${candidate.release_id}`;
    option.disabled = !candidate.compatibility.eligible;
    option.selected = candidate === state.current;
    option.textContent = `${candidate.channel} · ${candidate.release_id} · v${candidate.artifact.version}`
      + (candidate.compatibility.eligible ? "" : " · incompatible");
    options.appendChild(option);
  }
  releaseCandidateEl.replaceChildren(options);
  releaseFallbackBtn.disabled = releaseBusy
    || !view.effective_assignment
    || view.effective_assignment.channel === "stable";
  releaseFeedbackBindingEl.textContent =
    state.feedback_binding_proven
      ? `Feedback binds to loaded release ${state.current.release_id} · ${state.current.artifact.sha256}`
      : `Feedback is disabled: ${state.current?.release_id || "no release"} is selected, but these exact extension bytes are not locally proven loaded.`;
  releaseFeedbackEligible = state.feedback_binding_proven;
  releaseFeedbackTextEl.disabled = releaseBusy || !releaseFeedbackEligible;
  releaseFeedbackSubmitBtn.disabled = releaseBusy || !releaseFeedbackEligible;
  releaseContentEl.hidden = false;
  clearReleaseError();
  showReleaseNotice(
    `Selected ${state.current?.release_id || "no release yet"}. Loaded extension version: ${state.loaded_version}. `
    + "Extension binary install/reload is pending; this panel never downloads remote code or reloads Chrome automatically."
  );
}

async function refreshReleaseCockpit() {
  if (releaseBusy) return;
  setReleaseBusy(true);
  showReleaseNotice("Loading release assignments…");
  try {
    releaseDeviceId = await stableReleaseDeviceId();
    const payload = await releaseControlRequest(
      `/view?device_id=${encodeURIComponent(releaseDeviceId)}&surface=${encodeURIComponent("browser_extension")}`,
    );
    releaseView = parseReleaseControlView(payload);
    renderReleaseCockpit(releaseView);
  } catch (error) {
    releaseView = null;
    releaseFeedbackEligible = false;
    showReleaseNotice("");
    showReleaseError(String(error?.message || error));
  } finally {
    setReleaseBusy(false);
    if (releaseView) {
      releaseFallbackBtn.disabled = !releaseView.effective_assignment
        || releaseView.effective_assignment.channel === "stable";
    }
  }
}

function selectedReleaseCandidate() {
  if (!releaseView) return null;
  const [bundleId, releaseId] = releaseCandidateEl.value.split("\u0000");
  return releaseView.candidates.find((item) =>
    item.bundle_id === bundleId && item.release_id === releaseId) || null;
}

releaseRefreshBtn.addEventListener("click", refreshReleaseCockpit);

releaseAssignBtn.addEventListener("click", async () => {
  const candidate = selectedReleaseCandidate();
  if (!releaseView || !candidate || releaseBusy) return;
  setReleaseBusy(true);
  clearReleaseError();
  showReleaseNotice(`Selecting exact release ${candidate.release_id}…`);
  try {
    const requestBody = buildAssignmentRequest(releaseView, candidate, releaseDeviceId, releaseNonce());
    parseAssignmentMutationResponse(
      await releaseControlRequest("/assignments", { method: "POST", body: requestBody }),
    );
    showReleaseNotice("Assignment recorded. Extension binary install/reload remains pending.");
    setReleaseBusy(false);
    await refreshReleaseCockpit();
  } catch (error) {
    showReleaseError(String(error?.message || error));
  } finally {
    setReleaseBusy(false);
  }
});

releaseFallbackBtn.addEventListener("click", async () => {
  if (!releaseView || releaseBusy) return;
  setReleaseBusy(true);
  clearReleaseError();
  showReleaseNotice("Returning this browser assignment to last-known-good stable…");
  try {
    const requestBody = buildFallbackRequest(releaseView, releaseDeviceId, releaseNonce());
    parseAssignmentMutationResponse(
      await releaseControlRequest("/fallback", { method: "POST", body: requestBody }),
    );
    showReleaseNotice("Stable assignment recorded. Extension binary install/reload remains pending.");
    setReleaseBusy(false);
    await refreshReleaseCockpit();
  } catch (error) {
    showReleaseError(String(error?.message || error));
  } finally {
    setReleaseBusy(false);
  }
});

releaseFeedbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!releaseView || releaseBusy) return;
  setReleaseBusy(true);
  clearReleaseError();
  try {
    const requestBody = buildFeedbackRequest(
      releaseView,
      releaseDeviceId,
      releaseFeedbackTextEl.value,
      [],
      { digest_proven: false },
      releaseNonce(),
    );
    await releaseControlRequest("/feedback", { method: "POST", body: requestBody });
    releaseFeedbackTextEl.value = "";
    showReleaseNotice(`Feedback saved against exact release ${requestBody.release_id}. Binary install/reload is still pending.`);
  } catch (error) {
    showReleaseError(String(error?.message || error));
  } finally {
    setReleaseBusy(false);
  }
});

// ---- Durable audio history --------------------------------------------------

async function audioHistoryRequest(path, { method = "GET", body = null, responseType = "json" } = {}) {
  const config = await getEffectiveGatewayConfig();
  if (!config.gatewayUrl || !config.gatewayToken) {
    throw new Error("Configure an authenticated Chief MOA gateway to use audio history.");
  }
  const origin = new URL(config.gatewayUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) {
    throw new Error("Audio history requires HTTPS except on explicit loopback development gateways.");
  }
  const response = await fetch(new URL(path, `${config.gatewayUrl.replace(/\/+$/, "")}/`), {
    method,
    headers: {
      authorization: `Bearer ${config.gatewayToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : null,
    cache: "no-store",
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      detail = String(payload?.error || payload?.message || detail);
    } catch {}
    throw new Error(detail);
  }
  return responseType === "arrayBuffer" ? response.arrayBuffer() : response.json();
}

function formatAudioRecordDate(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function selectedTranscript(record) {
  const revisions = Array.isArray(record?.transcript?.revisions) ? record.transcript.revisions : [];
  return revisions.find((revision) => revision.revision_id === record.transcript.selected_revision_id)
    || revisions.at(-1)
    || null;
}

function renderAudioHistory(records) {
  const fragment = document.createDocumentFragment();
  for (const record of records) {
    const item = document.createElement("article");
    item.className = "audio-record";
    item.dataset.audioRecordId = String(record.audio_record_id || "");
    const summary = document.createElement("div");
    summary.className = "audio-record-summary";
    const duration = Number(record.duration_ms);
    summary.textContent = [
      formatAudioRecordDate(record.captured_at),
      record.source_kind === "audio_note" ? "audio note" : "voice turn",
      record.surface || "unknown surface",
      Number.isFinite(duration) ? `${(duration / 1000).toFixed(1)}s` : "",
    ].filter(Boolean).join(" · ");
    const transcript = document.createElement("div");
    transcript.className = "audio-record-transcript";
    transcript.textContent = selectedTranscript(record)?.transcript || "No transcript yet.";
    const actions = document.createElement("div");
    actions.className = "audio-record-actions";
    const play = document.createElement("button");
    play.type = "button";
    play.className = "audio-history-action";
    play.textContent = "Play";
    play.addEventListener("click", () => playAudioRecord(record, play));
    actions.appendChild(play);
    if (record.retranscribe_href) {
      const retranscribe = document.createElement("button");
      retranscribe.type = "button";
      retranscribe.className = "audio-history-action";
      retranscribe.textContent = "Retranscribe";
      retranscribe.addEventListener("click", () => retranscribeAudioRecord(record, retranscribe));
      actions.appendChild(retranscribe);
    }
    const details = document.createElement("details");
    const label = document.createElement("summary");
    label.textContent = `Provenance and ${record.transcript?.revisions?.length || 0} transcript version(s)`;
    details.appendChild(label);
    const provenance = document.createElement("div");
    provenance.textContent = [
      record.provenance?.provider ? `provider: ${record.provenance.provider}` : "",
      record.provenance?.model ? `model: ${record.provenance.model}` : "",
      record.provenance?.transcript_source ? `source: ${record.provenance.transcript_source}` : "",
      record.session_id ? `session: ${record.session_id}` : "",
      record.source_id ? `source id: ${record.source_id}` : "",
    ].filter(Boolean).join(" · ");
    details.appendChild(provenance);
    for (const revision of record.transcript?.revisions || []) {
      const row = document.createElement("div");
      row.className = "audio-record-revision";
      row.textContent = `Version ${revision.ordinal} · ${revision.source || "unknown"} · ${formatAudioRecordDate(revision.created_at)}\n${revision.transcript || ""}`;
      details.appendChild(row);
    }
    item.append(summary, transcript, actions, details);
    fragment.appendChild(item);
  }
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No retained audio recordings were found.";
    fragment.appendChild(empty);
  }
  audioHistoryListEl.replaceChildren(fragment);
}

async function refreshAudioHistory() {
  if (audioHistoryBusy) return;
  audioHistoryBusy = true;
  audioHistoryRefreshBtn.disabled = true;
  audioHistoryStatusEl.textContent = "Loading retained recordings…";
  try {
    const payload = await audioHistoryRequest("/v1/audio-history?limit=100");
    const records = Array.isArray(payload?.records) ? payload.records : [];
    renderAudioHistory(records);
    audioHistoryStatusEl.textContent = `${records.length} retained recording${records.length === 1 ? "" : "s"}. Originals and transcript versions are preserved.`;
  } catch (error) {
    audioHistoryStatusEl.textContent = `Audio history unavailable: ${String(error?.message || error)}`;
  } finally {
    audioHistoryBusy = false;
    audioHistoryRefreshBtn.disabled = false;
  }
}

async function playAudioRecord(record, button) {
  button.disabled = true;
  button.textContent = "Loading…";
  try {
    stopPlayback();
    if (nativeAudio) {
      nativeAudio.pause();
      URL.revokeObjectURL(nativeAudio.src);
      nativeAudio = null;
    }
    const bytes = await audioHistoryRequest(record.audio.playback_href, { responseType: "arrayBuffer" });
    if (record.audio.encoding === "pcm16") {
      playAssistantPcm(bytes);
    } else {
      const url = URL.createObjectURL(new Blob([bytes], { type: record.audio.content_type || "application/octet-stream" }));
      nativeAudio = new Audio(url);
      nativeAudio.addEventListener("ended", () => {
        URL.revokeObjectURL(url);
        nativeAudio = null;
      }, { once: true });
      await nativeAudio.play();
    }
    button.textContent = "Playing";
    setTimeout(() => { button.textContent = "Play"; }, Math.max(1200, Number(record.duration_ms) || 1200));
  } catch (error) {
    audioHistoryStatusEl.textContent = `Playback failed: ${String(error?.message || error)}`;
    button.textContent = "Play";
  } finally {
    button.disabled = false;
  }
}

async function retranscribeAudioRecord(record, button) {
  if (!confirm("Create a new Chirp transcript version? The original transcript will remain available.")) return;
  button.disabled = true;
  button.textContent = "Transcribing…";
  try {
    await audioHistoryRequest(record.retranscribe_href, { method: "POST", body: {} });
    await refreshAudioHistory();
  } catch (error) {
    audioHistoryStatusEl.textContent = `Retranscription failed: ${String(error?.message || error)}`;
  } finally {
    button.disabled = false;
    button.textContent = "Retranscribe";
  }
}

audioHistoryBtn.addEventListener("click", () => {
  const willOpen = audioHistoryPanel.hidden;
  audioHistoryPanel.hidden = !willOpen;
  audioHistoryBtn.setAttribute("aria-pressed", String(willOpen));
  if (willOpen) refreshAudioHistory();
});
audioHistoryRefreshBtn.addEventListener("click", refreshAudioHistory);

// One turn at a time. `turn` is null when idle.
let turn = null;
function roleForInstruction(text) {
  const value = String(text || "").trim().toLowerCase();
  if (/^(explain|describe|tell me (?:about|how|why))\b/.test(value)) return "explain";
  if (/^(help me|guide me|show me how)\b/.test(value)) return "help";
  if (/^(collaborate|work with me|pair with me)\b/.test(value)) return "collaborate";
  return "delegate";
}

function setStatus(text, state = "idle") {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function ensurePort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: "agee-panel" });
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    for (const [, entry] of pending) entry.reject(new Error("A.G. background restarted."));
    pending.clear();
    if (turn) failTurn(turn, "A.G. background restarted mid-turn. Try again.");
    showHistoryError("Saved history may be stale while A.G. reconnects.");
    scheduleReconnect();
  });
  return port;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delayMs = Math.min(5000, 250 * (2 ** reconnectAttempt));
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    reconnectAttempt += 1;
    try {
      ensurePort();
      await refreshHistory({ reason: "background reconnect" });
      // A history error is handled by the visible Retry affordance. Once the
      // worker answered, do not turn a gateway outage into a hidden polling
      // loop from the panel.
      reconnectAttempt = 0;
      return;
    } catch {}
    scheduleReconnect();
  }, delayMs);
}

function request(msg, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const reqId = nextReqId++;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error("A.G. background did not respond."));
    }, timeoutMs);
    pending.set(reqId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    try {
      ensurePort().postMessage({ reqId, ...msg });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(reqId);
      reject(error);
    }
  });
}

function onPortMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.reqId != null && pending.has(msg.reqId)) {
    const entry = pending.get(msg.reqId);
    pending.delete(msg.reqId);
    entry.resolve(msg);
    return;
  }
  if (msg.cmd === "voiceSessionEvent") handleVoiceEvent(msg);
}

// ---- Conversation log -------------------------------------------------------

function firstText(record, fields) {
  for (const field of fields) {
    const value = record?.[field];
    const text = typeof value === "string"
      ? value.trim()
      : typeof value?.text === "string"
        ? value.text.trim()
        : "";
    if (text) return text;
  }
  return "";
}

function stableRecordBase(record, index) {
  return String(
    record?.message_id || record?.messageId || record?.id || record?.turn_id ||
    record?.turnId || record?.browser_turn_id || `legacy_${index}`
  );
}

function normalizeHistoryMessages(payload) {
  const records = Array.isArray(payload?.messages)
    ? payload.messages
    : Array.isArray(payload?.turns)
      ? payload.turns
      : [];
  const messages = [];
  records.forEach((record, index) => {
    if (!record || typeof record !== "object") return;
    const baseId = stableRecordBase(record, index);
    const turnId = String(record.turn_id || record.turnId || record.browser_turn_id || "");
    const rawSpeaker = String(record.speaker || record.role || "").toLowerCase();
    const speaker = rawSpeaker === "user" || rawSpeaker === "assistant" ? rawSpeaker : "";
    const source = String(record.source_surface || record.surface || record.source || "").trim();
    const kind = String(record.source_kind || record.kind || record.input_mode || "").trim();
    const completion = String(record.completion_state || record.status || "").trim();
    const meta = [source, kind, completion && completion !== "completed" ? completion : ""].filter(Boolean).join(" · ");
    if (speaker) {
      const text = speaker === "user"
        ? firstText(record, ["text", "content", "user_text", "transcript", "instruction"])
        : firstText(record, ["text", "content", "assistant_text", "reply_text", "reply", "display"]);
      if (text) messages.push({ id: baseId, turnId, speaker, text, meta });
      return;
    }

    // Legacy `/turns` records pair the user and assistant in one object. Project
    // them into two stable display messages without using text similarity as an
    // identity heuristic.
    const userText = firstText(record, ["user_text", "transcript", "instruction"]);
    const assistantText = firstText(record, ["assistant_text", "reply_text", "reply", "display", "text"]);
    if (userText) messages.push({ id: `${baseId}:user`, turnId: turnId || baseId, speaker: "user", text: userText, meta });
    if (assistantText) messages.push({ id: `${baseId}:assistant`, turnId: turnId || baseId, speaker: "assistant", text: assistantText, meta });
  });

  const seen = new Set();
  return messages.filter((message) => {
    if (!message.id || seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function renderHistory(messages) {
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    const item = document.createElement("article");
    item.className = "history-message";
    item.dataset.messageId = message.id;
    item.dataset.turnId = message.turnId;
    item.dataset.speaker = message.speaker;
    const speaker = document.createElement("div");
    speaker.className = "speaker";
    speaker.textContent = message.speaker === "assistant" ? "A.G." : "you";
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = message.text;
    item.append(speaker, body);
    if (message.meta) {
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = message.meta;
      item.appendChild(meta);
    }
    fragment.appendChild(item);
  }
  historyEl.replaceChildren(fragment);
}

function showHistoryError(message) {
  historyEl.dataset.stale = historyEl.children.length ? "true" : "false";
  historyErrorTextEl.textContent = message || "Could not load saved history.";
  historyErrorEl.hidden = false;
}

function clearHistoryError() {
  historyEl.dataset.stale = "false";
  historyErrorEl.hidden = true;
  historyErrorTextEl.textContent = "";
}

function reconcileTerminalCard(state, messages) {
  if (!state?.ui?.card) return false;
  const ids = new Set([state.turnId, state.canonicalTurnId].filter(Boolean));
  if (!ids.size || !messages.some((message) => ids.has(message.turnId))) return false;
  state.ui.card.remove();
  state.ui = null;
  return true;
}

async function refreshHistory({ reason = "refresh", reconcileState = null } = {}) {
  if (historyRefresh) return historyRefresh;
  const generation = ++historyRefreshGeneration;
  if (!turn) setStatus(reason === "initial" ? "Loading saved history…" : "Refreshing history…");
  historyRefresh = request({ cmd: "history" })
    .then((response) => {
      if (!response?.ok) throw new Error(response?.error || "Could not load saved history.");
      const messages = normalizeHistoryMessages(response);
      if (generation !== historyRefreshGeneration) return false;
      renderHistory(messages);
      clearHistoryError();
      reconcileTerminalCard(reconcileState, messages);
      if (!turn) setStatus("Ready.");
      return true;
    })
    .catch((error) => {
      if (generation === historyRefreshGeneration) {
        showHistoryError(`${String(error?.message || error)} Saved messages were not cleared. Retry when the gateway is available.`);
        if (!turn) setStatus("History needs attention.", "error");
      }
      return false;
    })
    .finally(() => {
      historyRefresh = null;
    });
  return historyRefresh;
}

function refreshAfterTerminal(state) {
  refreshHistory({ reason: "turn completed", reconcileState: state });
  setTimeout(() => refreshHistory({ reason: "turn reconciliation", reconcileState: state }), 1200);
}

function addTurnCard(youText) {
  const card = document.createElement("div");
  card.className = "turn";
  const you = document.createElement("div");
  you.className = "you";
  you.textContent = youText || "…";
  const ag = document.createElement("div");
  ag.className = "ag pending";
  ag.textContent = "listening…";
  card.append(you, ag);
  logEl.appendChild(card);
  card.scrollIntoView({ block: "end" });
  return { card, you, ag };
}

function updateCard(state, { you, reply, error, pendingLabel } = {}) {
  if (!state?.ui) return;
  if (you != null) state.ui.you.textContent = you || "…";
  if (pendingLabel != null && !state.replyText) {
    state.ui.ag.textContent = pendingLabel;
    state.ui.ag.className = "ag pending";
  }
  if (reply != null) {
    state.ui.ag.textContent = reply;
    state.ui.ag.className = "ag";
  }
  if (error != null) {
    state.ui.ag.textContent = error;
    state.ui.ag.className = "ag error";
  }
  state.ui.card.scrollIntoView({ block: "end" });
}

// ---- Audio playback ---------------------------------------------------------

function primeAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      audioCtx = null;
    }
  }
  if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
}

function stopPlayback() {
  for (const source of [...playbackSources]) {
    try {
      source.stop();
    } catch {}
    playbackSources.delete(source);
  }
  playbackTime = 0;
  playbackRate = 1;
}

function base64ToBuffer(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function playAssistantPcm(buffer) {
  if (!buffer || !buffer.byteLength) return;
  primeAudio();
  if (!audioCtx) return;
  const pcm = new Int16Array(buffer);
  const audioBuffer = audioCtx.createBuffer(1, pcm.length, 16000);
  const channel = audioBuffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.playbackRate.value = playbackRate || 1;
  source.connect(audioCtx.destination);
  playbackSources.add(source);
  source.onended = () => playbackSources.delete(source);
  const startAt = Math.max(audioCtx.currentTime + 0.02, playbackTime || 0);
  source.start(startAt);
  playbackTime = startAt + audioBuffer.duration / (playbackRate || 1);
}

// ---- Turn lifecycle ---------------------------------------------------------

function newTurnState(kind, youText) {
  return {
    kind, // "voice" | "text"
    turnId: `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    voiceSessionId: null,
    transcript: "",
    replyText: "",
    done: false,
    watchdog: null,
    ui: addTurnCard(youText || ""),
  };
}

function armWatchdog(state) {
  clearTimeout(state.watchdog);
  state.watchdog = setTimeout(() => {
    if (!state.done) failTurn(state, "The turn timed out. Check the gateway and try again.");
  }, TURN_WATCHDOG_MS);
}

function closeTurnSession(state, reason) {
  if (state.voiceSessionId) {
    request({ cmd: "voiceSessionClose", voiceSessionId: state.voiceSessionId, reason }).catch(() => {});
    state.voiceSessionId = null;
  }
}

function finishTurn(state) {
  if (state.done) return;
  state.done = true;
  clearTimeout(state.watchdog);
  closeTurnSession(state, "turn done");
  if (turn === state) turn = null;
  talkBtn.dataset.state = "idle";
  talkBtn.textContent = "Hold to talk";
  sendBtn.disabled = false;
  setStatus("Ready.");
  refreshAfterTerminal(state);
}

function renderMicrophoneRecovery(state, message, recovery) {
  if (!state?.ui || recovery?.target !== "microphone_permission") return false;
  const copy = document.createElement("div");
  copy.textContent = message;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "microphone-recovery-action";
  button.textContent = recovery.action_label || "Take me to microphone setup";
  button.addEventListener("click", () => {
    button.disabled = true;
    request({ cmd: "openOptions", target: recovery.target })
      .then((result) => {
        if (!result?.ok) button.disabled = false;
      })
      .catch(() => {
        button.disabled = false;
      });
  });
  state.ui.ag.replaceChildren(copy, button);
  state.ui.ag.className = "ag error microphone-recovery";
  return true;
}

function failTurn(state, message, recovery = null) {
  if (state.done) return;
  updateCard(state, { error: message });
  renderMicrophoneRecovery(state, message, recovery);
  setStatus(message, "error");
  state.done = true;
  clearTimeout(state.watchdog);
  closeTurnSession(state, "turn failed");
  if (turn === state) turn = null;
  talkBtn.dataset.state = "idle";
  talkBtn.textContent = "Hold to talk";
  sendBtn.disabled = false;
  refreshAfterTerminal(state);
}

// Recover the stored assistant reply when the live stream died mid-turn: the
// gateway persists the turn even when the socket drops, same path the overlay
// uses.
function recoverTurn(state, fallbackMessage) {
  if (state.done) return;
  setTimeout(() => {
    if (state.done) return;
    request({ cmd: "voiceTurnFetch", turnId: state.turnId })
      .then((res) => {
        if (state.done) return;
        const reply = String(res?.turn?.assistant_text || res?.turn?.reply_text || "").trim();
        const heard = String(res?.turn?.transcript || "").trim();
        if (reply) {
          if (heard && !state.transcript) updateCard(state, { you: heard });
          updateCard(state, { reply });
          finishTurn(state);
        } else {
          failTurn(state, fallbackMessage);
        }
      })
      .catch(() => failTurn(state, fallbackMessage));
  }, 1500);
}

function handleVoiceEvent(payload) {
  const state = turn;
  if (!state || state.done) return;
  if (payload.voiceSessionId && state.voiceSessionId && payload.voiceSessionId !== state.voiceSessionId) return;
  armWatchdog(state);

  if (payload.audio) {
    playAssistantPcm(base64ToBuffer(payload.audio));
    return;
  }
  const msg = payload.event && typeof payload.event === "object" ? payload.event : payload;
  if (!msg.type) return;

  if (msg.type === "session_ready") {
    if (state.kind === "voice") setStatus("Listening — release to send.", "listening");
    return;
  }
  if (msg.type === "transcript_partial" || msg.type === "transcript_final") {
    const text = String(msg.text || "").trim();
    if (!text) return;
    state.transcript = text;
    updateCard(state, { you: text });
    return;
  }
  if (msg.type === "assistant_text") {
    const text = String(msg.text || "").trim();
    if (!text) return;
    state.replyText = text;
    setStatus("A.G. is replying.", "speaking");
    updateCard(state, { reply: text });
    return;
  }
  if (msg.type === "assistant_audio_start") {
    setStatus("A.G. is speaking.", "speaking");
    const rate = Number(msg.playback_rate);
    playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    playbackTime = Math.max(audioCtx?.currentTime || 0, playbackTime || 0) + 0.04;
    return;
  }
  if (msg.type === "turn_done") {
    const status = String(msg.status || "completed").toLowerCase();
    if (msg.turn_id) state.canonicalTurnId = String(msg.turn_id);
    if (status === "error") {
      failTurn(state, String(msg.message || msg.error || "Voice turn failed."));
      return;
    }
    if (status === "no_speech" && !state.replyText) {
      updateCard(state, { error: "Didn't catch that." });
    } else if (!state.replyText) {
      recoverTurn(state, "The turn completed but no reply arrived.");
      return;
    }
    finishTurn(state);
    return;
  }
  if (msg.type === "error") {
    if (msg.recoverable === false || msg.code === "microphone_capture_failed") {
      failTurn(state, String(msg.message || "Voice capture failed."), msg.recovery);
      return;
    }
    recoverTurn(state, String(msg.message || "The live connection dropped."));
    return;
  }
  if (msg.type === "connection_closed") {
    recoverTurn(state, "The live connection closed before the reply arrived.");
  }
}

async function startTurn(kind, options) {
  if (turn && !turn.done) return null;
  stopPlayback();
  primeAudio();
  const state = newTurnState(kind, options.youText);
  turn = state;
  armWatchdog(state);
  try {
    const res = await request({
      cmd: "voiceSessionStart",
      turnId: state.turnId,
      cueId: `panel_${state.turnId}`,
      capture: kind === "voice" ? "extension-offscreen" : "content-script",
      autoCommit: kind === "voice",
    });
    if (!res?.ok || !res.voiceSessionId) {
      failTurn(state, String(res?.error || "Could not start the turn."));
      return null;
    }
    state.voiceSessionId = res.voiceSessionId;
    const attached = await request({ cmd: "voiceSessionAttach", voiceSessionId: res.voiceSessionId });
    if (!attached?.ok) {
      failTurn(state, String(attached?.error || "Could not attach to the voice session."));
      return null;
    }
    return state;
  } catch (error) {
    failTurn(state, String(error?.message || error));
    return null;
  }
}

// ---- Voice: hold to talk ----------------------------------------------------

let holdActive = false;

async function beginHold() {
  if (holdActive || (turn && !turn.done)) return;
  holdActive = true;
  talkBtn.dataset.state = "listening";
  talkBtn.textContent = "Listening — release to send";
  setStatus("Starting voice…", "listening");
  const state = await startTurn("voice", { youText: "" });
  if (!state) {
    holdActive = false;
    talkBtn.dataset.state = "idle";
    talkBtn.textContent = "Hold to talk";
    return;
  }
  updateCard(state, { pendingLabel: "listening…" });
  // The user let go before the session finished starting: commit immediately.
  if (!holdActive) commitHold();
}

function commitHold() {
  const wasActive = holdActive;
  holdActive = false;
  const state = turn;
  if (!state || state.done || state.kind !== "voice") return;
  if (!state.voiceSessionId) return; // beginHold will commit once started
  if (!wasActive) return;
  talkBtn.dataset.state = "busy";
  talkBtn.textContent = "Thinking…";
  setStatus("Processing…");
  updateCard(state, { pendingLabel: "processing…" });
  request({
    cmd: "voiceSessionControl",
    voiceSessionId: state.voiceSessionId,
    message: { type: "commit_turn", turn_id: state.turnId },
  }).then((res) => {
    if (!res?.ok) failTurn(state, String(res?.error || "The voice connection was not open."));
  }).catch((error) => failTurn(state, String(error?.message || error)));
}

talkBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  talkBtn.setPointerCapture?.(e.pointerId);
  beginHold();
});
talkBtn.addEventListener("pointerup", () => commitHold());
talkBtn.addEventListener("pointercancel", () => commitHold());

// Bound per-document so hold-to-talk keeps working after the UI moves into a
// floating picture-in-picture window (key events go to that window's document).
function attachHoldKeyHandlers(doc) {
  doc.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat) return;
    if (doc.activeElement === textInput) return;
    e.preventDefault();
    beginHold();
  });
  doc.addEventListener("keyup", (e) => {
    if (e.code !== "Space") return;
    if (doc.activeElement === textInput) return;
    e.preventDefault();
    commitHold();
  });
}
attachHoldKeyHandlers(document);

// ---- Float: pop the surface out of the browser -------------------------------
// Document picture-in-picture gives an always-on-top window that floats above
// other applications, the closest an extension can get to rendering outside
// the browser (the Gemini floating bar is native browser UI). The window is
// owned by this panel page: the panel must stay open while floated, so leave a
// note behind and move the UI back when the float closes.
const floatBtn = document.getElementById("floatBtn");
let pipWindow = null;

function restoreFromFloat() {
  if (!pipWindow) return;
  const nodes = [...pipWindow.document.body.children].filter((node) => !node.classList?.contains("floating-note"));
  document.body.querySelector(".floating-note")?.remove();
  document.body.append(...nodes);
  pipWindow = null;
  floatBtn.textContent = "Float";
}

async function floatOut() {
  if (pipWindow) {
    pipWindow.close();
    return;
  }
  if (!window.documentPictureInPicture?.requestWindow) {
    setStatus("Floating window is not available in this Chrome.", "error");
    return;
  }
  try {
    pipWindow = await documentPictureInPicture.requestWindow({ width: 380, height: 560 });
  } catch (error) {
    pipWindow = null;
    setStatus(`Could not float: ${String(error?.message || error)}`, "error");
    return;
  }
  for (const style of document.querySelectorAll("style")) {
    pipWindow.document.head.append(style.cloneNode(true));
  }
  pipWindow.document.title = "A.G.";
  // Moving (adopting) the nodes keeps element references and listeners alive.
  pipWindow.document.body.append(...document.body.children);
  attachHoldKeyHandlers(pipWindow.document);
  pipWindow.addEventListener("pagehide", restoreFromFloat);
  const note = document.createElement("p");
  note.className = "floating-note";
  note.textContent = "A.G. is floating in an always-on-top window. Keep this panel open while it floats; close the floating window to bring A.G. back here.";
  document.body.append(note);
  floatBtn.textContent = "Unfloat";
}

floatBtn.addEventListener("click", () => {
  floatOut();
});

// ---- Typed browser-agent turns -----------------------------------------------

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text || (turn && !turn.done)) return;
  textInput.value = "";
  sendBtn.disabled = true;
  setStatus("Sending…");
  const state = newTurnState("text", text);
  turn = state;
  armWatchdog(state);
  const role = roleForInstruction(text);
  updateCard(state, { pendingLabel: `${role} is working…` });
  request({
    cmd: "browserRoleTurn",
    cueId: `panel_${state.turnId}`,
    text,
    role,
  }, TURN_WATCHDOG_MS).then((res) => {
    if (!res?.ok) {
      failTurn(state, String(res?.error || "The browser agent rejected the turn."));
      return;
    }
    state.canonicalTurnId = String(res.browser_turn_id || res.turn_id || "");
    updateCard(state, { reply: String(res.summary || "Done.") });
    finishTurn(state);
  }).catch((error) => failTurn(state, String(error?.message || error)));
});

ensurePort();
historyRetryBtn.addEventListener("click", () => refreshHistory({ reason: "manual retry" }));
refreshHistory({ reason: "initial" });
refreshReleaseCockpit();

// Keep the small diagnostic surface used by the browser smoke harness. These
// functions were document globals before sidepanel.js became an ES module.
Object.assign(globalThis, { refreshHistory, request, roleForInstruction });
