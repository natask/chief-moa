// A.G. side panel — the extension-owned agent surface. Runs as an extension
// page so it renders on every tab (chrome:// pages included) and persists
// across tab switches. All gateway traffic goes through the background service
// worker over a long-lived port; mic capture happens in the background's
// offscreen document, never here (extension pages cannot render the
// getUserMedia permission prompt).

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const talkBtn = document.getElementById("talk");
const form = document.getElementById("form");
const textInput = document.getElementById("text");
const sendBtn = document.getElementById("sendBtn");
const agentModeSelector = document.getElementById("agentModeSelector");
const agentModeButtons = [...document.querySelectorAll("[data-agent-mode-option]")];
const settingsForm = document.getElementById("settingsForm");
const settingsSearch = document.getElementById("settingsSearch");
const settingsRecommend = document.getElementById("settingsRecommend");
const settingsAll = document.getElementById("settingsAll");
const settingsResults = document.getElementById("settingsResults");
const settingsDetail = document.getElementById("settingsDetail");

const TURN_WATCHDOG_MS = 90000;
const BROWSER_AGENT_ROLE_KEY = "ageeBrowserAgentRole";
const BROWSER_AGENT_ROLES = new Set(["delegate", "help", "collaborate", "explain"]);

let port = null;
let nextReqId = 1;
const pending = new Map();

let audioCtx = null;
let playbackTime = 0;
let playbackRate = 1;
const playbackSources = new Set();

// One turn at a time. `turn` is null when idle.
let turn = null;
let selectedAgentRole = "delegate";
let selectedSettingId = "";
let renderedSettingButtons = [];

function setAgentRole(value, { persist = true } = {}) {
  const role = String(value || "").trim().toLowerCase();
  selectedAgentRole = BROWSER_AGENT_ROLES.has(role) ? role : "delegate";
  if (agentModeSelector) agentModeSelector.dataset.agentMode = selectedAgentRole;
  for (const button of agentModeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.agentModeOption === selectedAgentRole));
  }
  if (persist) chrome.storage.local.set({ [BROWSER_AGENT_ROLE_KEY]: selectedAgentRole }).catch(() => {});
}

for (const button of agentModeButtons) {
  button.addEventListener("click", () => setAgentRole(button.dataset.agentModeOption));
}

chrome.storage.local.get({ [BROWSER_AGENT_ROLE_KEY]: "delegate" }).then((stored) => {
  setAgentRole(stored[BROWSER_AGENT_ROLE_KEY], { persist: false });
}).catch(() => setAgentRole("delegate", { persist: false }));

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
  });
  return port;
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

async function microphonePermissionState() {
  if (!globalThis.navigator?.permissions?.query) return "unknown";
  try {
    const result = await globalThis.navigator.permissions.query({ name: "microphone" });
    return ["granted", "denied", "prompt"].includes(result?.state) ? result.state : "unknown";
  } catch {
    return "unknown";
  }
}

function formatSettingValue(value) {
  if (value === null || value === undefined || value === "") return "Not set";
  if (Array.isArray(value)) return value.join(", ") || "None";
  if (typeof value === "object") return "Configured";
  return String(value);
}

function settingMetadata(setting) {
  const constraints = Array.isArray(setting?.constraints) && setting.constraints.length
    ? setting.constraints.join(" ")
    : "No additional constraints published.";
  return [
    `Owner: ${setting?.owner || "unknown"}.`,
    `Current: ${formatSettingValue(setting?.current)}.`,
    `Default: ${formatSettingValue(setting?.default)}.`,
    `Takes effect: ${setting?.takes_effect || "unspecified"}.`,
    `Redaction: ${setting?.redaction || "none"}.`,
    `Constraints: ${constraints}`,
  ].join(" ");
}

function renderSettingDetail(setting) {
  if (!settingsDetail || !setting) return;
  selectedSettingId = setting.id;
  for (const button of renderedSettingButtons) {
    button.setAttribute("aria-selected", String(button.dataset.settingId === selectedSettingId));
  }
  const title = document.createElement("strong");
  title.textContent = setting.title || setting.id;
  const metadata = document.createElement("div");
  metadata.textContent = settingMetadata(setting);
  settingsDetail.replaceChildren(title, metadata);
  if (setting.deep_link?.target === "microphone_permission") {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "setting-deep-link";
    action.textContent = setting.deep_link.label || "Open microphone setup";
    action.addEventListener("click", () => {
      action.disabled = true;
      request({ cmd: "openOptions", target: setting.deep_link.target })
        .then((result) => {
          if (!result?.ok) action.disabled = false;
        })
        .catch(() => {
          action.disabled = false;
        });
    });
    settingsDetail.appendChild(action);
  }
  settingsDetail.hidden = false;
}

async function selectSetting(setting) {
  const response = await request({
    cmd: "settingsQuery",
    operation: "get",
    id: setting.id,
    microphonePermission: await microphonePermissionState(),
  });
  renderSettingDetail(response?.ok && response.setting ? response.setting : setting);
}

function renderSettingsResults(payload) {
  if (!settingsResults) return;
  settingsResults.replaceChildren();
  renderedSettingButtons = [];
  const settings = Array.isArray(payload?.settings) ? payload.settings : [];
  if (!settings.length) {
    const empty = document.createElement("div");
    empty.className = "settings-empty";
    empty.textContent = payload?.error ? `Settings unavailable: ${payload.error}` : "No registered settings matched.";
    settingsResults.appendChild(empty);
  }
  for (const setting of settings) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "setting-row";
    row.dataset.settingId = setting.id;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    const title = document.createElement("span");
    title.className = "setting-row-title";
    title.textContent = setting.title || setting.id;
    const current = document.createElement("span");
    current.className = "setting-row-current";
    current.textContent = `Current: ${formatSettingValue(setting.current)}`;
    const description = document.createElement("span");
    description.className = "setting-row-description";
    description.textContent = setting.description || "Registered setting.";
    row.append(title, current, description);
    row.addEventListener("click", () => selectSetting(setting).catch((error) => setStatus(String(error?.message || error), "error")));
    renderedSettingButtons.push(row);
    settingsResults.appendChild(row);
  }
  settingsResults.hidden = false;
  if (settingsDetail) settingsDetail.hidden = true;
}

async function runSettingsQuery(operation = "search") {
  const query = String(settingsSearch?.value || "").trim();
  if ((operation === "search" || operation === "recommend") && !query) {
    setStatus("Type what you want to find in settings.", "error");
    settingsSearch?.focus();
    return null;
  }
  setStatus(operation === "list" ? "Listing registered settings…" : "Searching registered settings…");
  const payload = await request({
    cmd: "settingsQuery",
    operation,
    query,
    limit: 20,
    microphonePermission: await microphonePermissionState(),
  });
  renderSettingsResults(payload);
  setStatus(payload?.gateway_error ? "Browser settings shown; gateway catalog is unavailable." : "Settings ready.");
  return payload;
}

settingsForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  runSettingsQuery("search").catch((error) => setStatus(String(error?.message || error), "error"));
});
settingsRecommend?.addEventListener("click", () => {
  runSettingsQuery("recommend").catch((error) => setStatus(String(error?.message || error), "error"));
});
settingsAll?.addEventListener("click", () => {
  runSettingsQuery("list").catch((error) => setStatus(String(error?.message || error), "error"));
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && String(event.key || "").toLowerCase() === "k") {
    event.preventDefault();
    settingsSearch?.focus();
  }
});

// ---- Conversation log -------------------------------------------------------

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

function confirmDelegation(state) {
  return new Promise((resolve) => {
    const message = document.createElement("p");
    message.className = "delegation-confirm-copy";
    message.textContent = "Delegate this task on the current site for up to 20 steps? A.G. may click, type, select, scroll, press keys, wait, and capture page evidence. Navigation or sensitive/out-of-scope work stops for approval.";
    const actions = document.createElement("div");
    actions.className = "delegation-confirm-actions";
    const allow = document.createElement("button");
    allow.type = "button";
    allow.textContent = "Delegate task";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.className = "secondary";
    actions.append(allow, cancel);
    state.ui.ag.className = "ag confirming";
    state.ui.ag.replaceChildren(message, actions);
    const finish = (confirmed) => {
      allow.disabled = true;
      cancel.disabled = true;
      resolve(confirmed);
    };
    allow.addEventListener("click", () => finish(true), { once: true });
    cancel.addEventListener("click", () => finish(false), { once: true });
  });
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
  const role = selectedAgentRole;
  let delegationConfirmed = false;
  if (role === "delegate") {
    delegationConfirmed = await confirmDelegation(state);
    if (!delegationConfirmed) {
      updateCard(state, { reply: "Delegation cancelled." });
      finishTurn(state);
      return;
    }
  }
  updateCard(state, { pendingLabel: `${role} is working…` });
  request({
    cmd: "browserRoleTurn",
    cueId: `panel_${state.turnId}`,
    text,
    role,
    delegationConfirmed,
  }, TURN_WATCHDOG_MS).then((res) => {
    if (!res?.ok) {
      failTurn(state, String(res?.error || "The browser agent rejected the turn."));
      return;
    }
    updateCard(state, { reply: String(res.summary || "Done.") });
    finishTurn(state);
  }).catch((error) => failTurn(state, String(error?.message || error)));
});

ensurePort();
setStatus("Ready.");

export {
  addTurnCard,
  armWatchdog,
  attachHoldKeyHandlers,
  base64ToBuffer,
  beginHold,
  closeTurnSession,
  commitHold,
  confirmDelegation,
  ensurePort,
  failTurn,
  finishTurn,
  floatOut,
  handleVoiceEvent,
  newTurnState,
  onPortMessage,
  playAssistantPcm,
  primeAudio,
  recoverTurn,
  renderMicrophoneRecovery,
  renderSettingDetail,
  renderSettingsResults,
  request,
  restoreFromFloat,
  setAgentRole,
  setStatus,
  runSettingsQuery,
  selectSetting,
  settingMetadata,
  startTurn,
  stopPlayback,
  updateCard,
};
