// Ag side panel — the extension-owned companion surface. Runs as an extension
// page so it renders on every tab (chrome:// pages included) and persists
// across tab switches. All gateway traffic goes through the background service
// worker over a long-lived port; mic capture happens in the background's
// offscreen document, never here (extension pages cannot render the
// getUserMedia permission prompt).

import { getEffectiveGatewayConfig } from "./config.js";
import { createAudioNoteOutbox } from "./audio-note-outbox.js";
import { renderAudioNoteOutbox } from "./audio-note-outbox-view.js";
import { createDeviceCredentialRuntime } from "./device-credential-runtime.js";
import { createBrowserToolCatalogView } from "./browser-tool-catalog-view.js";
import {
  AUDIO_NOTES_PATH,
  audioNoteAudioPath,
  audioNoteFilename,
  audioNoteItems,
  audioNotePath,
  audioNotePlaybackBlob,
  audioNoteState,
  formatBytes,
  formatDuration,
} from "./audio-note-library.js";
import {
  CAPTURE_BLOCKS_PATH,
  canHandoffPromotion,
  captureBlockHandoffPath,
  captureBlockHandoffRequest,
  captureBlockPath,
  captureBlockRequest,
  captureBlockRetryPath,
  confirmedGoalFromText,
  handoffPresentation,
  newPromotionRecord,
  promotionPresentation,
  promotionRecordWithBlock,
  promotionRecordWithConfirmedGoal,
  promotionRecordWithHandoff,
  promotionStorageKey,
  usablePromotionRecord,
} from "./audio-note-promotion.js";
import "./transcript-revision-protocol.js";
import {
  buildAssignmentRequest,
  buildFallbackRequest,
  buildFeedbackRequest,
  deriveReleaseCockpitState,
  parseAssignmentMutationResponse,
  parseReleaseControlView,
} from "./release-control-runtime.js";
import {
  videoEvidenceRef,
  videoIntentEditCommand,
  videoIntentItems,
  videoNoteId,
} from "./video-intent-view.js";

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
const companionIdentityEl = document.getElementById("companionIdentity");
const companionIdentityImageEl = document.getElementById("companionIdentityImage");
const companionIdentityNameEl = document.getElementById("companionIdentityName");
const capturedIntentsEl = document.getElementById("capturedIntents");
const capturedIntentsStatusEl = document.getElementById("capturedIntentsStatus");
const capturedIntentsRefreshBtn = document.getElementById("capturedIntentsRefresh");
const voiceNotesEl = document.getElementById("voiceNotes");
const voiceNotesStatusEl = document.getElementById("voiceNotesStatus");
const voiceNotesRefreshBtn = document.getElementById("voiceNotesRefresh");

const TURN_WATCHDOG_MS = 90000;
const ACTIVE_COMPANION_CACHE_KEY = "ageeActiveCompanionPetCache";

let port = null;
let nextReqId = 1;
const pending = new Map();
let reconnectTimer = null;
let reconnectAttempt = 0;
let historyRefresh = null;
let historyRefreshGeneration = 0;
const historyRevisionLedger = new Map();
const videoObjectUrls = new Set();
const audioNotePlaybackUrls = new Set();
const audioNoteBlobCache = new Map();
const audioNoteOutbox = createAudioNoteOutbox();

let audioCtx = null;
let playbackTime = 0;
let playbackRate = 1;
const playbackSources = new Set();

function compactIdentityText(value, max = 80) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeCompanionImage(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 350 * 1024) return "";
  if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol === "chrome-extension:" && url.hostname === chrome.runtime.id) return url.href;
  } catch {}
  return "";
}

function renderCompanionIdentity(payload) {
  const record = payload?.active_companion || payload?.activeCompanion || payload;
  const pet = record?.pet && typeof record.pet === "object" ? record.pet : {};
  const sprite = pet.sprite && typeof pet.sprite === "object" ? pet.sprite : {};
  const name = compactIdentityText(record?.companion_name || record?.name || pet.name) || "Ag";
  const image = safeCompanionImage(sprite.image_data_url || sprite.asset_url || pet.asset_url);
  companionIdentityNameEl.textContent = name;
  companionIdentityImageEl.src = image || chrome.runtime.getURL("moa-mark.png");
  companionIdentityEl.setAttribute("aria-label", name === "Ag" ? "Ag companion" : `Ag, ${name} companion`);
}

async function hydrateCompanionIdentity() {
  const stored = await chrome.storage.local.get({ [ACTIVE_COMPANION_CACHE_KEY]: null });
  renderCompanionIdentity(stored[ACTIVE_COMPANION_CACHE_KEY]);
  chrome.runtime.sendMessage({ cmd: "activeCompanionPet" })
    .then((result) => {
      if (result?.ok) renderCompanionIdentity(result.active_companion);
    })
    .catch(() => {});
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[ACTIVE_COMPANION_CACHE_KEY]) {
    renderCompanionIdentity(changes[ACTIVE_COMPANION_CACHE_KEY].newValue);
  }
});

async function capturedIntentGateway(path, { method = "GET", body, responseType = "json" } = {}) {
  const config = await getEffectiveGatewayConfig();
  if (!config.gatewayUrl) throw new Error("No gateway is configured.");
  const headers = {};
  if (config.gatewayToken) headers.authorization = `Bearer ${config.gatewayToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${config.gatewayUrl}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Gateway returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  if (responseType === "blob") return response.blob();
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Gateway returned an unreadable response.");
  }
}

function setVoiceNotesStatus(message, state = "ready") {
  voiceNotesStatusEl.textContent = String(message || "");
  voiceNotesStatusEl.dataset.state = state;
}

function revokeAudioNotePlaybackUrls() {
  for (const url of audioNotePlaybackUrls) URL.revokeObjectURL(url);
  audioNotePlaybackUrls.clear();
  audioNoteBlobCache.clear();
}

async function audioNoteBlob(note) {
  const id = String(note?.id || "");
  if (audioNoteBlobCache.has(id)) return audioNoteBlobCache.get(id);
  const loading = capturedIntentGateway(audioNoteAudioPath(note), { responseType: "blob" });
  audioNoteBlobCache.set(id, loading);
  try {
    return await loading;
  } catch (error) {
    audioNoteBlobCache.delete(id);
    throw error;
  }
}

function voiceNoteTimestamp(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "time unavailable" : date.toLocaleString();
}

function setVoiceNoteOperation(element, message, state = "ready") {
  element.textContent = String(message || "");
  element.dataset.state = state;
}

async function savedAudioNotePromotion(note) {
  const key = promotionStorageKey(note);
  const stored = await chrome.storage.local.get({ [key]: null });
  return usablePromotionRecord(note, stored[key]);
}

async function saveAudioNotePromotion(note, record) {
  await chrome.storage.local.set({ [promotionStorageKey(note)]: record });
  return record;
}

function renderAudioNote(note) {
  const card = document.createElement("article");
  card.className = "voice-note-card";
  card.dataset.noteId = String(note.id || "");

  const title = document.createElement("div");
  title.className = "voice-note-title";
  title.textContent = String(note.label || "").trim() || "Untitled voice note";

  const metadata = document.createElement("div");
  metadata.className = "voice-note-meta";
  metadata.textContent = [
    voiceNoteTimestamp(note.created_at),
    formatDuration(note.duration_ms),
    formatBytes(note.bytes ?? note.audio?.bytes),
    String(note.content_type || note.audio?.content_type || "audio").slice(0, 100),
    String(note.surface || "surface unavailable").slice(0, 80),
  ].join(" · ");

  const processing = audioNoteState(note);
  const state = document.createElement("div");
  state.className = "voice-note-state";
  state.dataset.state = processing.failed ? "error" : "ready";
  state.textContent = processing.failed
    ? `${processing.state} · ${processing.error || "The recording is still stored. Retry when processing is available."}`
    : processing.state === "stored"
      ? "Stored raw audio · no reasoning or agent work"
      : processing.state;

  const operation = document.createElement("div");
  operation.className = "voice-note-operation";
  operation.setAttribute("role", "status");
  if (processing.retryable) operation.textContent = "Processing is retryable; refresh after retrying from a capture-block surface.";

  const promotion = document.createElement("div");
  promotion.className = "voice-note-promotion";
  promotion.setAttribute("role", "status");

  const transcript = document.createElement("pre");
  transcript.className = "voice-note-transcript";
  transcript.setAttribute("aria-label", "Transcript preview");
  transcript.hidden = true;

  const handoffStatus = document.createElement("div");
  handoffStatus.className = "voice-note-handoff";
  handoffStatus.setAttribute("role", "status");
  handoffStatus.hidden = true;

  const goalFields = document.createElement("div");
  goalFields.className = "voice-note-goal";
  goalFields.hidden = true;
  const outcomeLabel = document.createElement("label");
  outcomeLabel.textContent = "Desired outcome";
  const outcome = document.createElement("textarea");
  outcome.rows = 3;
  outcome.maxLength = 100000;
  outcome.placeholder = "What durable outcome should Switchboard own?";
  outcomeLabel.append(outcome);
  const criteriaLabel = document.createElement("label");
  criteriaLabel.textContent = "Acceptance criteria · one per line";
  const criteria = document.createElement("textarea");
  criteria.rows = 4;
  criteria.maxLength = 32032;
  criteria.placeholder = "What observable evidence must be true before this is complete?";
  criteriaLabel.append(criteria);
  goalFields.append(outcomeLabel, criteriaLabel);

  const actions = document.createElement("div");
  actions.className = "voice-note-actions";

  let promotionRecord = null;
  const prepare = document.createElement("button");
  prepare.type = "button";
  prepare.disabled = true;
  prepare.textContent = "Prepare transcript";

  const handoff = document.createElement("button");
  handoff.type = "button";
  handoff.hidden = true;
  handoff.disabled = true;

  const renderPromotion = (record) => {
    const view = promotionPresentation(record);
    promotion.textContent = view.label;
    promotion.dataset.state = view.error ? "error" : view.state;
    prepare.textContent = view.action;
    const literal = record?.snapshot?.literal_transcript || "";
    transcript.textContent = literal;
    transcript.hidden = !literal;
    const handoffView = handoffPresentation(record);
    handoff.hidden = !handoffView;
    handoff.disabled = !handoffView;
    handoffStatus.hidden = !handoffView;
    handoff.textContent = handoffView?.action || "";
    handoffStatus.textContent = handoffView?.label || "";
    goalFields.hidden = !handoffView;
    const confirmedGoal = record?.confirmed_goal;
    if (confirmedGoal) {
      outcome.value = confirmedGoal.desired_outcome;
      criteria.value = confirmedGoal.acceptance_criteria.join("\n");
    }
    const goalLocked = Boolean(confirmedGoal || handoffView?.sent);
    outcome.disabled = goalLocked;
    criteria.disabled = goalLocked;
  };

  prepare.addEventListener("click", async () => {
    prepare.disabled = true;
    const retrying = promotionRecord?.capture_block_id
      && promotionRecord.snapshot?.processing_state === "failed"
      && promotionRecord.snapshot?.retryable === true;
    setVoiceNoteOperation(operation, retrying
      ? "Queuing a retry for this note's retained audio…"
      : promotionRecord?.capture_block_id
        ? "Refreshing this note's capture block…"
        : "Persisting a retry identity and queuing this note for transcription…");
    try {
      if (!promotionRecord) {
        promotionRecord = newPromotionRecord(note);
        await saveAudioNotePromotion(note, promotionRecord);
      }
      const payload = promotionRecord.capture_block_id
        ? await capturedIntentGateway(
          retrying
            ? captureBlockRetryPath(promotionRecord.capture_block_id)
            : captureBlockPath(promotionRecord.capture_block_id),
          retrying ? { method: "POST" } : {},
        )
        : await capturedIntentGateway(CAPTURE_BLOCKS_PATH, {
          method: "POST",
          body: captureBlockRequest(note, promotionRecord),
        });
      promotionRecord = promotionRecordWithBlock(note, promotionRecord, payload);
      await saveAudioNotePromotion(note, promotionRecord);
      renderPromotion(promotionRecord);
      setVoiceNoteOperation(operation, "Capture state refreshed. No assistant or agent work was started.");
    } catch (error) {
      setVoiceNoteOperation(operation, `Could not prepare transcript: ${String(error?.message || error)} Select Retry.`, "error");
      prepare.textContent = "Retry prepare transcript";
    } finally {
      prepare.disabled = false;
    }
  });

  handoff.addEventListener("click", async () => {
    if (!canHandoffPromotion(promotionRecord)) return;
    if (!promotionRecord.confirmed_goal) {
      let goal;
      try {
        goal = confirmedGoalFromText(outcome.value, criteria.value);
      } catch (error) {
        setVoiceNoteOperation(operation, String(error?.message || error), "error");
        return;
      }
      const criteriaPreview = goal.acceptance_criteria.map((item) => `- ${item}`).join("\n");
      const confirmed = confirm(
        `Send this exact selected source to Agent Switchboard for execution?\n\nDesired outcome:\n${goal.desired_outcome}\n\nAcceptance criteria:\n${criteriaPreview}\n\nThis can start agent work.`,
      );
      if (!confirmed) {
        setVoiceNoteOperation(operation, "Switchboard handoff cancelled. No work was started.");
        return;
      }
      const confirmedRecord = promotionRecordWithConfirmedGoal(promotionRecord, goal);
      try {
        await saveAudioNotePromotion(note, confirmedRecord);
      } catch (error) {
        setVoiceNoteOperation(
          operation,
          `Could not retain the confirmed goal before handoff: ${String(error?.message || error)}`,
          "error",
        );
        return;
      }
      promotionRecord = confirmedRecord;
      renderPromotion(promotionRecord);
    }
    handoff.disabled = true;
    setVoiceNoteOperation(operation, "Sending the exact transcribed capture block to Switchboard…");
    try {
      const payload = await capturedIntentGateway(
        captureBlockHandoffPath(promotionRecord.capture_block_id),
        { method: "POST", body: captureBlockHandoffRequest(promotionRecord) },
      );
      promotionRecord = promotionRecordWithHandoff(promotionRecord, payload);
      await saveAudioNotePromotion(note, promotionRecord);
      renderPromotion(promotionRecord);
      setVoiceNoteOperation(operation, "Switchboard receipt retained. Retry returns the same server-side admission.");
    } catch (error) {
      setVoiceNoteOperation(operation, `Could not send to Switchboard: ${String(error?.message || error)} Select Retry.`, "error");
      handoff.textContent = "Retry Send to Switchboard";
      handoff.disabled = false;
    }
  });

  savedAudioNotePromotion(note).then((record) => {
    promotionRecord = record;
    renderPromotion(record);
    prepare.disabled = false;
  }).catch((error) => {
    promotion.textContent = `Saved transcription state unavailable: ${String(error?.message || error)}`;
    promotion.dataset.state = "error";
  });

  const play = document.createElement("button");
  play.type = "button";
  play.textContent = "Play";
  play.addEventListener("click", async () => {
    play.disabled = true;
    setVoiceNoteOperation(operation, "Loading the authenticated recording…");
    try {
      const source = await audioNoteBlob(note);
      const playable = await audioNotePlaybackBlob(note, source);
      const url = URL.createObjectURL(playable);
      audioNotePlaybackUrls.add(url);
      const player = document.createElement("audio");
      player.controls = true;
      player.autoplay = true;
      player.preload = "metadata";
      player.src = url;
      const previous = card.querySelector("audio");
      if (previous) previous.replaceWith(player);
      else card.appendChild(player);
      setVoiceNoteOperation(operation, "Recording loaded from the authenticated gateway.");
      play.textContent = "Replay";
    } catch (error) {
      setVoiceNoteOperation(operation, `Could not play: ${String(error?.message || error)} Select Retry play.`, "error");
      play.textContent = "Retry play";
    } finally {
      play.disabled = false;
    }
  });

  const download = document.createElement("button");
  download.type = "button";
  download.textContent = "Download";
  download.addEventListener("click", async () => {
    download.disabled = true;
    setVoiceNoteOperation(operation, "Downloading from the authenticated gateway…");
    try {
      const source = await audioNoteBlob(note);
      const url = URL.createObjectURL(source);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = audioNoteFilename(note);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setVoiceNoteOperation(operation, "Download started.");
      download.textContent = "Download";
    } catch (error) {
      setVoiceNoteOperation(operation, `Could not download: ${String(error?.message || error)} Select Retry download.`, "error");
      download.textContent = "Retry download";
    } finally {
      download.disabled = false;
    }
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "delete";
  remove.textContent = "Delete";
  remove.addEventListener("click", async () => {
    if (!confirm("Delete this voice note and its retained audio? This cannot be undone.")) return;
    remove.disabled = true;
    setVoiceNoteOperation(operation, "Deleting the authenticated recording…");
    try {
      await capturedIntentGateway(audioNotePath(note), { method: "DELETE" });
      card.remove();
      audioNoteBlobCache.delete(String(note.id || ""));
      setVoiceNotesStatus(voiceNotesEl.children.length
        ? "Voice note deleted. Remaining notes are newest first."
        : "Voice note deleted. No saved voice notes remain.");
    } catch (error) {
      setVoiceNoteOperation(operation, `Could not delete: ${String(error?.message || error)} Select Retry delete.`, "error");
      remove.textContent = "Retry delete";
      remove.disabled = false;
    }
  });

  actions.append(prepare, handoff, play, download, remove);
  card.append(title, metadata, state, promotion, transcript, handoffStatus, goalFields, operation, actions);
  return card;
}

async function refreshAudioNotes() {
  voiceNotesRefreshBtn.disabled = true;
  setVoiceNotesStatus("Loading saved voice notes…");
  let pending = [];
  let pendingError = "";
  try {
    pending = await audioNoteOutbox.list();
  } catch (error) {
    pendingError = String(error?.message || error);
  }
  const pendingCards = () => pending.map((record) => renderAudioNoteOutbox(record, {
    outbox: audioNoteOutbox,
    getConfig: getEffectiveGatewayConfig,
    onChanged: refreshAudioNotes,
  }));
  try {
    const payload = await capturedIntentGateway(`${AUDIO_NOTES_PATH}?limit=100`);
    const notes = audioNoteItems(payload);
    revokeAudioNotePlaybackUrls();
    voiceNotesEl.replaceChildren(...pendingCards(), ...notes.map(renderAudioNote));
    voiceNotesEl.dataset.stale = "false";
    voiceNotesRefreshBtn.textContent = "Refresh";
    const localStatus = pendingError
      ? `Local recovery unavailable: ${pendingError}`
      : pending.length ? `${pending.length} voice note${pending.length === 1 ? "" : "s"} saved locally for retry. ` : "";
    setVoiceNotesStatus(`${localStatus}${notes.length
      ? `${notes.length} gateway voice note${notes.length === 1 ? "" : "s"}, newest first.`
      : "No gateway voice notes yet. Capture and recovery do not ask the assistant or launch work."}`, pendingError ? "error" : "ready");
  } catch (error) {
    voiceNotesEl.replaceChildren(...pendingCards());
    voiceNotesEl.dataset.stale = "true";
    setVoiceNotesStatus(`${pending.length ? `${pending.length} original recording${pending.length === 1 ? " is" : "s are"} saved locally. ` : ""}Gateway voice notes unavailable: ${String(error?.message || error)} Select Retry.`, "error");
    voiceNotesRefreshBtn.textContent = "Retry";
  } finally {
    voiceNotesRefreshBtn.disabled = false;
  }
}

function videoIntentHistory(history) {
  const details = document.createElement("details");
  details.className = "video-intent-history";
  const summary = document.createElement("summary");
  const events = Array.isArray(history?.events) ? history.events : [];
  summary.textContent = `History · ${events.length} durable event${events.length === 1 ? "" : "s"}`;
  const list = document.createElement("ol");
  for (const event of events) {
    const item = document.createElement("li");
    item.textContent = `${event.event_type} · ${event.occurred_at || "time unavailable"}`;
    list.appendChild(item);
  }
  details.append(summary, list);
  const source = events.find((event) => event.event_type === "intent.source_recorded");
  if (typeof source?.payload?.raw_text === "string") {
    const original = document.createElement("pre");
    original.className = "video-intent-source";
    original.textContent = source.payload.raw_text;
    details.appendChild(original);
  }
  return details;
}

function renderVideoIntent({ intent, note, history }) {
  const card = document.createElement("article");
  card.className = "video-intent-card";
  const status = document.createElement("div");
  status.className = "video-intent-status";
  status.textContent = intent.lifecycle_state || "captured";
  const objective = document.createElement("textarea");
  objective.value = intent.normalized_objective || intent.statement || "";
  objective.maxLength = 2000;
  objective.setAttribute("aria-label", "Editable captured intent");
  const evidence = videoEvidenceRef(intent);
  const meta = document.createElement("div");
  meta.className = "video-intent-meta";
  meta.textContent = note
    ? `${evidence} · kept until you delete it · ${note.bytes || 0} bytes · ${note.duration_ms || 0} ms`
    : `${evidence} · original recording deleted; transcript and intent history retained`;
  const provenance = document.createElement("div");
  provenance.className = "video-intent-provenance";
  provenance.textContent = note?.transcript
    ? `Transcript: ${note.transcript.state} · ${note.transcript.provider || "provider unavailable"} · ${note.transcript.model || "model unavailable"} · SHA-256 ${note.sha256}`
    : "Transcript provenance remains in durable intent history.";
  const actions = document.createElement("div");
  actions.className = "video-intent-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save edit";
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await capturedIntentGateway(`/v1/intent-runtime/intents/${encodeURIComponent(intent.intent_id)}/transition`, {
        method: "POST", body: videoIntentEditCommand(intent, objective.value, crypto.randomUUID()),
      });
      capturedIntentsStatusEl.textContent = "Intent edit saved as durable history.";
      await refreshCapturedIntents();
    } catch (error) {
      capturedIntentsStatusEl.textContent = `Could not save: ${String(error?.message || error)}`;
    } finally { save.disabled = false; }
  });
  actions.appendChild(save);
  if (note?.video?.href) {
    if (note.transcript?.state === "failed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry transcript";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        try {
          await capturedIntentGateway(`/v1/video-notes/${encodeURIComponent(note.id)}/intent`, {
            method: "POST", body: { user_confirmed: true },
          });
          capturedIntentsStatusEl.textContent = "Transcript retry completed.";
          await refreshCapturedIntents();
        } catch (error) {
          capturedIntentsStatusEl.textContent = `Transcript retry failed: ${String(error?.message || error)}`;
          retry.disabled = false;
        }
      });
      actions.appendChild(retry);
    }
    const load = document.createElement("button");
    load.type = "button";
    load.textContent = "Load recording";
    load.addEventListener("click", async () => {
      load.disabled = true;
      try {
        const blob = await capturedIntentGateway(note.video.href, { responseType: "blob" });
        const url = URL.createObjectURL(blob);
        videoObjectUrls.add(url);
        const player = document.createElement("video");
        player.controls = true;
        player.src = url;
        card.appendChild(player);
        load.remove();
      } catch (error) {
        capturedIntentsStatusEl.textContent = `Could not load recording: ${String(error?.message || error)}`;
        load.disabled = false;
      }
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete";
    remove.textContent = "Delete recording";
    remove.addEventListener("click", async () => {
      if (!confirm("Delete the original screen recording? The transcript and durable intent history will remain.")) return;
      remove.disabled = true;
      try {
        await capturedIntentGateway(`/v1/video-notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
        capturedIntentsStatusEl.textContent = "Original recording deleted; transcript and intent history retained.";
        await refreshCapturedIntents();
      } catch (error) {
        capturedIntentsStatusEl.textContent = `Could not delete recording: ${String(error?.message || error)}`;
        remove.disabled = false;
      }
    });
    actions.append(load, remove);
  }
  card.append(status, objective, meta, provenance, actions, videoIntentHistory(history));
  return card;
}

async function refreshCapturedIntents() {
  capturedIntentsRefreshBtn.disabled = true;
  capturedIntentsStatusEl.textContent = "Loading captured intents…";
  for (const url of videoObjectUrls) URL.revokeObjectURL(url);
  videoObjectUrls.clear();
  try {
    const payload = await capturedIntentGateway("/v1/intent-runtime/intents?limit=100");
    const intents = videoIntentItems(payload).slice(0, 20);
    const records = await Promise.all(intents.map(async (intent) => {
      const id = videoNoteId(intent);
      const [noteResult, history] = await Promise.all([
        capturedIntentGateway(`/v1/video-notes/${encodeURIComponent(id)}`).catch(() => null),
        capturedIntentGateway(`/v1/intent-runtime/intents/${encodeURIComponent(intent.intent_id)}/history`).catch(() => null),
      ]);
      return { intent, note: noteResult?.note || null, history };
    }));
    capturedIntentsEl.replaceChildren(...records.map(renderVideoIntent));
    capturedIntentsStatusEl.textContent = intents.length
      ? "Video captures stay here as editable intents; no work is dispatched automatically."
      : "No video-led intents yet. Shift-click the browser record button to capture one.";
  } catch (error) {
    capturedIntentsStatusEl.textContent = `Captured intents unavailable: ${String(error?.message || error)}`;
  } finally { capturedIntentsRefreshBtn.disabled = false; }
}

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
    for (const [, entry] of pending) entry.reject(new Error("Ag background restarted."));
    pending.clear();
    if (turn) failTurn(turn, "Ag background restarted mid-turn. Try again.");
    showHistoryError("Saved history may be stale while Ag reconnects.");
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
      reject(new Error("Ag background did not respond."));
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
      ? value
      : typeof value?.text === "string"
        ? value.text
        : "";
    if (text.trim()) return text;
  }
  return "";
}

function stableRecordBase(record, index) {
  return String(
    record?.message_id || record?.messageId || record?.id || record?.turn_id ||
    record?.turnId || record?.browser_turn_id || `legacy_${index}`
  );
}

function historyTimestamp(record) {
  return String(
    record?.created_at || record?.createdAt || record?.timestamp ||
    record?.completed_at || record?.updated_at || ""
  );
}

function normalizeVoiceHistory(record) {
  const history = record?.voice_history;
  if (!history || typeof history !== "object" || Array.isArray(history)) return null;
  const revisions = Array.isArray(history.transcript_revisions)
    ? history.transcript_revisions.flatMap((entry) => {
      const revision = Number(entry?.revision);
      const transcript = typeof entry?.transcript === "string" ? entry.transcript : "";
      if (!Number.isSafeInteger(revision) || revision < 0 || !transcript.trim()) return [];
      return [{
        revision,
        transcript,
        source: String(entry.source || entry.transcript_source || "").trim(),
        createdAt: String(entry.created_at || "").trim(),
      }];
    }).slice(0, 20)
    : [];
  const currentRevision = Number(history.current_revision);
  const revisionCount = Number(history.revision_count);
  return {
    audioAccessible: history.audio_accessible === true,
    audioAccessibility: String(history.audio_accessibility || "").trim(),
    retranscriptionSupported: history.retranscription_supported === true,
    retranscriptionAvailable: history.retranscription_available === true,
    currentRevision: Number.isSafeInteger(currentRevision) && currentRevision >= 0 ? currentRevision : null,
    revisionCount: Number.isSafeInteger(revisionCount) && revisionCount >= 0 ? revisionCount : revisions.length,
    revisionsTruncated: history.revisions_truncated === true,
    revisions,
  };
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
    const createdAt = historyTimestamp(record);
    const voiceHistory = speaker === "user" && kind.toLowerCase() === "voice"
      ? normalizeVoiceHistory(record)
      : null;
    const sessionId = String(record.session_id || record.sessionId || "").trim();
    const branchId = String(record.branch_id || record.branchId || "").trim();
    if (speaker) {
      const text = speaker === "user"
        ? firstText(record, ["text", "content", "user_text", "transcript", "instruction"])
        : firstText(record, ["text", "content", "assistant_text", "reply_text", "reply", "display"]);
      if (text) messages.push({
        id: baseId, turnId: turnId || baseId, speaker, text, meta, createdAt,
        sourceIndex: index, kind, completion, sessionId, branchId, voiceHistory,
      });
      return;
    }

    // Legacy `/turns` records pair the user and assistant in one object. Project
    // them into two stable display messages without using text similarity as an
    // identity heuristic.
    const userText = firstText(record, ["user_text", "transcript", "instruction"]);
    const assistantText = firstText(record, ["assistant_text", "reply_text", "reply", "display", "text"]);
    if (userText) messages.push({
      id: `${baseId}:user`, turnId: turnId || baseId, speaker: "user", text: userText,
      meta, createdAt, sourceIndex: index, kind, completion,
    });
    if (assistantText) messages.push({
      id: `${baseId}:assistant`, turnId: turnId || baseId, speaker: "assistant", text: assistantText,
      meta, createdAt, sourceIndex: index, kind, completion,
    });
  });

  const seen = new Set();
  const unique = messages.filter((message) => {
    if (!message.id || seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
  const turns = new Map();
  for (const message of unique) {
    const group = turns.get(message.turnId) || {
      id: message.turnId,
      messages: [],
      sourceIndex: message.sourceIndex,
      createdAt: message.createdAt,
    };
    group.messages.push(message);
    group.sourceIndex = Math.max(group.sourceIndex, message.sourceIndex);
    if (message.createdAt > group.createdAt) group.createdAt = message.createdAt;
    turns.set(message.turnId, group);
  }
  const reverseUntimedTurns = payload?.source === "turns";
  const ordered = [...turns.values()]
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      (reverseUntimedTurns
        ? right.sourceIndex - left.sourceIndex
        : left.sourceIndex - right.sourceIndex) ||
      right.id.localeCompare(left.id))
    .flatMap((group) => group.messages.sort((left, right) =>
      (left.speaker === "user" ? 0 : 1) - (right.speaker === "user" ? 0 : 1) ||
      left.sourceIndex - right.sourceIndex ||
      left.id.localeCompare(right.id)));
  const latestVoiceTranscript = ordered.find((message) =>
    message.speaker === "user" &&
    message.kind.toLowerCase() === "voice" &&
    ["completed", "complete"].includes(message.completion.toLowerCase()));
  if (latestVoiceTranscript) latestVoiceTranscript.latestVoiceTranscript = true;
  return ordered;
}

async function copyHistoryText(text) {
  const value = String(text ?? "");
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {}
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.documentElement.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {}
  textarea.remove();
  return copied;
}

function historyCopyButton(message, textSource = () => message.text) {
  const button = document.createElement("button");
  const speaker = message.speaker === "assistant" ? "Ag response" : "transcript";
  button.type = "button";
  button.className = "history-copy";
  button.textContent = "Copy";
  button.setAttribute("aria-label", `Copy ${speaker}`);
  button.setAttribute("aria-live", "polite");
  button.addEventListener("click", async () => {
    button.disabled = true;
    const copied = await copyHistoryText(textSource());
    button.textContent = copied ? "Copied" : "Copy failed";
    button.setAttribute("aria-label", copied ? `${speaker} copied` : `Could not copy ${speaker}`);
    setTimeout(() => {
      button.disabled = false;
      button.textContent = "Copy";
      button.setAttribute("aria-label", `Copy ${speaker}`);
    }, 1600);
  });
  return button;
}

function renderTranscriptRevisions(item, message, selectRevision) {
  const history = message.voiceHistory;
  if (!history?.revisions.length) return;
  const fragment = document.createDocumentFragment();
  const rows = [];
  for (const revision of [...history.revisions].sort((left, right) => left.revision - right.revision)) {
    const row = document.createElement("div");
    row.className = "history-transcript-revision";
    row.dataset.revision = String(revision.revision);
    row.dataset.selected = String(revision.revision === history.currentRevision);
    const label = document.createElement("button");
    label.type = "button";
    label.className = "revision-label";
    label.textContent = revision.revision === 0 ? "Original transcript" : `Transcript revision ${revision.revision}`;
    label.setAttribute("aria-pressed", String(revision.revision === history.currentRevision));
    label.addEventListener("click", () => {
      for (const candidate of rows) {
        const selected = candidate === row;
        candidate.dataset.selected = String(selected);
        candidate.querySelector(".revision-label")?.setAttribute("aria-pressed", String(selected));
      }
      selectRevision(revision);
    });
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = revision.transcript;
    row.append(label, body, historyCopyButton(message, () => revision.transcript));
    rows.push(row);
    fragment.appendChild(row);
  }
  item.appendChild(fragment);
}

function historyRetranscribeButton(message) {
  const available = message.speaker === "user" &&
    message.kind.toLowerCase() === "voice" &&
    message.voiceHistory?.retranscriptionAvailable === true &&
    message.voiceHistory?.audioAccessible === true &&
    message.voiceHistory?.retranscriptionSupported === true &&
    Boolean(message.sessionId && message.turnId);
  if (!available) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "history-retranscribe";
  button.textContent = "Re-transcribe";
  button.setAttribute("aria-label", "Re-transcribe retained audio");
  button.setAttribute("aria-live", "polite");
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Re-transcribing…";
    try {
      const response = await request({
        cmd: "historyRetranscribe",
        sessionId: message.sessionId,
        turnId: message.turnId,
      }, TURN_WATCHDOG_MS);
      if (!response?.ok) throw new Error(response?.error || "Re-transcription failed.");
      button.textContent = "Re-transcribed";
      setStatus("Transcript updated.");
      await refreshHistory({ reason: "re-transcription completed" });
    } catch (error) {
      button.disabled = false;
      button.textContent = "Re-transcribe";
      button.setAttribute("aria-label", `Re-transcription failed. ${String(error?.message || error)}`);
      setStatus(`Re-transcription failed: ${String(error?.message || error)}`, "error");
    }
  });
  return button;
}

function renderHistoryMessage(message) {
  const item = document.createElement("section");
  item.className = "history-message";
  item.dataset.messageId = message.id;
  item.dataset.turnId = message.turnId;
  item.dataset.speaker = message.speaker;
  if (message.voiceHistory?.currentRevision != null) {
    item.dataset.transcriptRevision = String(message.voiceHistory.currentRevision);
    item.dataset.selectedTranscriptRevision = String(message.voiceHistory.currentRevision);
  }
  if (message.latestVoiceTranscript) {
    item.classList.add("latest-voice-transcript");
    item.dataset.latestVoiceTranscript = "true";
  }
  const speaker = document.createElement("div");
  speaker.className = "speaker";
  speaker.textContent = message.speaker === "assistant" ? "Ag" : "you";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = message.text;
  item.append(speaker, body);
  let selectedTranscript = message.text;
  item.appendChild(historyCopyButton(message, () => selectedTranscript));
  renderTranscriptRevisions(item, message, (revision) => {
    selectedTranscript = revision.transcript;
    body.textContent = revision.transcript;
    item.dataset.selectedTranscriptRevision = String(revision.revision);
  });
  const retranscribe = historyRetranscribeButton(message);
  if (retranscribe) item.appendChild(retranscribe);
  if (message.meta) {
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = message.meta;
    item.appendChild(meta);
  }
  return item;
}

function renderHistory(messages) {
  const turns = new Map();
  for (const message of messages) {
    const group = turns.get(message.turnId) || [];
    group.push(message);
    turns.set(message.turnId, group);
  }
  const fragment = document.createDocumentFragment();
  for (const [turnId, turnMessages] of turns) {
    const card = document.createElement("article");
    card.className = "history-turn";
    card.dataset.turnId = turnId;
    const latestVoice = turnMessages.some((message) => message.latestVoiceTranscript);
    if (latestVoice) {
      card.classList.add("latest-voice-turn");
      card.dataset.latestVoiceTurn = "true";
    }
    card.append(...turnMessages.map(renderHistoryMessage));
    fragment.appendChild(card);
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
      const guardedMessages = AgeeTranscriptRevisionProtocol.guardHistory(messages, historyRevisionLedger);
      if (generation !== historyRefreshGeneration) return false;
      renderHistory(guardedMessages);
      clearHistoryError();
      reconcileTerminalCard(reconcileState, guardedMessages);
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
  for (const delay of [5000, 30000, 120000]) setTimeout(() => refreshHistory({ reason: "transcript reconciliation" }), delay);
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
    transcriptFinal: false,
    replyText: "",
    done: false,
    terminalPending: false,
    transcriptRevision: null,
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
          if (heard) {
            state.transcript = heard;
            state.transcriptFinal = true;
            updateCard(state, { you: heard });
          }
          updateCard(state, { reply });
          finishTurn(state);
        } else {
          failTurn(state, fallbackMessage);
        }
      })
      .catch(() => failTurn(state, fallbackMessage));
  }, 1500);
}

function finalTranscriptFromEvent(message) {
  return firstText(message, ["transcript", "user_text", "final_transcript"]);
}

async function reconcileStoredVoiceTurn(state) {
  const ids = [...new Set([state.canonicalTurnId, state.turnId].filter(Boolean))];
  for (const turnId of ids) {
    try {
      const response = await request({ cmd: "voiceTurnFetch", turnId }, 3000);
      const stored = response?.turn;
      if (!stored) continue;
      const heard = firstText(stored, ["transcript", "user_text", "final_transcript"]);
      const reply = firstText(stored, ["assistant_text", "reply_text", "reply"]);
      if (heard) {
        state.transcript = heard;
        state.transcriptFinal = true;
        updateCard(state, { you: heard });
      }
      if (reply) {
        state.replyText = reply;
        updateCard(state, { reply });
      }
      return true;
    } catch {}
  }
  return false;
}

async function completeVoiceTurn(state, message) {
  if (state.done || state.terminalPending) return;
  state.terminalPending = true;
  const status = String(message.status || "completed").toLowerCase();
  if (message.turn_id) state.canonicalTurnId = String(message.turn_id);
  const eventTranscript = finalTranscriptFromEvent(message);
  if (eventTranscript) {
    state.transcript = eventTranscript;
    state.transcriptFinal = true;
    updateCard(state, { you: eventTranscript });
  }
  if (status === "error") {
    state.terminalPending = false;
    failTurn(state, String(message.message || message.error || "Voice turn failed."));
    return;
  }

  // `turn_done` means the gateway has closed the canonical record. Re-read it
  // before retiring the live card so a provisional hypothesis cannot remain
  // visible when the stored final transcript differs.
  await reconcileStoredVoiceTurn(state);
  state.terminalPending = false;
  if (state.done) return;
  if (status === "no_speech" && !state.replyText) {
    updateCard(state, { error: "Didn't catch that." });
    finishTurn(state);
    return;
  }
  if (!state.replyText) {
    recoverTurn(state, "The turn completed but no reply arrived.");
    return;
  }
  finishTurn(state);
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
    AgeeTranscriptRevisionProtocol.acceptReady(state.transcriptRevision, msg);
    if (state.kind === "voice") setStatus("Listening — release to send.", "listening");
    return;
  }
  if (msg.type === "transcript_prefix_revision") {
    const revision = AgeeTranscriptRevisionProtocol.acceptPrefixRevision(state.transcriptRevision, msg);
    if (!revision) return;
    state.transcript = revision.text;
    updateCard(state, { you: revision.text });
    return;
  }
  if (msg.type === "transcript_partial" || msg.type === "transcript_final") {
    if (msg.type === "transcript_partial" && state.transcriptFinal && !state.transcriptRevision?.supported) return;
    const snapshot = AgeeTranscriptRevisionProtocol.acceptStreamingSnapshot(state.transcriptRevision, msg);
    if (!snapshot) return;
    const text = snapshot.text;
    state.transcript = text;
    state.transcriptFinal = msg.type === "transcript_final";
    updateCard(state, { you: text });
    return;
  }
  if (msg.type === "assistant_text") {
    const text = String(msg.text || "").trim();
    if (!text) return;
    state.replyText = text;
    setStatus("Ag is replying.", "speaking");
    updateCard(state, { reply: text });
    return;
  }
  if (msg.type === "assistant_audio_start") {
    setStatus("Ag is speaking.", "speaking");
    const rate = Number(msg.playback_rate);
    playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    playbackTime = Math.max(audioCtx?.currentTime || 0, playbackTime || 0) + 0.04;
    return;
  }
  if (msg.type === "turn_done") {
    AgeeTranscriptRevisionProtocol.markTerminal(state.transcriptRevision);
    completeVoiceTurn(state, msg);
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
      // Manual capture: the panel's own control ends the turn. Silence does not
      // send, so a pause mid-thought cannot cut the utterance short.
      autoCommit: false,
    });
    if (!res?.ok || !res.voiceSessionId) {
      failTurn(state, String(res?.error || "Could not start the turn."));
      return null;
    }
    state.voiceSessionId = res.voiceSessionId;
    state.transcriptRevision = AgeeTranscriptRevisionProtocol.createState({ sessionId: res.session_id, branchId: res.branch_id, turnId: state.turnId });
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
let holdCancelled = false;

async function beginHold() {
  if (holdActive || (turn && !turn.done)) return;
  holdActive = true;
  holdCancelled = false;
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
  if (holdCancelled) cancelHold();
  else if (!holdActive) commitHold();
}

function commitHold() {
  const wasActive = holdActive;
  holdActive = false;
  if (holdCancelled) return;
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

function cancelHold() {
  holdActive = false;
  holdCancelled = true;
  const state = turn;
  if (!state || state.done || state.kind !== "voice" || !state.voiceSessionId || state.cancelRequested) return;
  state.cancelRequested = true;
  talkBtn.dataset.state = "idle";
  talkBtn.textContent = "Hold to talk";
  setStatus("Capture cancelled.");
  request({
    cmd: "voiceSessionControl",
    voiceSessionId: state.voiceSessionId,
    message: { type: "cancel_turn", turn_id: state.turnId },
  }).catch(() => null).finally(() => finishTurn(state));
}

talkBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  talkBtn.setPointerCapture?.(e.pointerId);
  beginHold();
});
talkBtn.addEventListener("pointerup", () => commitHold());
talkBtn.addEventListener("pointercancel", () => cancelHold());

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
  pipWindow.document.title = "Ag";
  // Moving (adopting) the nodes keeps element references and listeners alive.
  pipWindow.document.body.append(...document.body.children);
  attachHoldKeyHandlers(pipWindow.document);
  pipWindow.addEventListener("pagehide", restoreFromFloat);
  const note = document.createElement("p");
  note.className = "floating-note";
  note.textContent = "Ag is floating in an always-on-top window. Keep this panel open while it floats; close the floating window to bring Ag back here.";
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
hydrateCompanionIdentity().catch(() => renderCompanionIdentity(null));
historyRetryBtn.addEventListener("click", () => refreshHistory({ reason: "manual retry" }));
voiceNotesRefreshBtn.addEventListener("click", refreshAudioNotes);
capturedIntentsRefreshBtn.addEventListener("click", refreshCapturedIntents);
refreshAudioNotes();
refreshCapturedIntents();
refreshHistory({ reason: "initial" });
refreshReleaseCockpit();
createBrowserToolCatalogView({
  request,
  list: document.getElementById("browserToolList"),
  status: document.getElementById("browserToolStatus"),
  refreshButton: document.getElementById("browserToolRefresh"),
}).refresh();

addEventListener("pagehide", () => {
  revokeAudioNotePlaybackUrls();
});

// Keep the small diagnostic surface used by the browser smoke harness. These
// functions were document globals before sidepanel.js became an ES module.
function startVoiceLifecycleDiagnostic(turnId) {
  if (turn && !turn.done) return false;
  const state = newTurnState("voice", "");
  state.turnId = String(turnId || state.turnId);
  turn = state;
  return true;
}

Object.assign(globalThis, {
  handleVoiceEvent,
  refreshHistory,
  request,
  roleForInstruction,
  startVoiceLifecycleDiagnostic,
});
