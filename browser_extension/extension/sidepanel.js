// A.G. side panel — the extension-owned agent surface. Runs as an extension
// page so it renders on every tab (chrome:// pages included) and persists
// across tab switches. All gateway traffic goes through the background service
// worker over a long-lived port; mic capture happens in the background's
// offscreen document, never here (extension pages cannot render the
// getUserMedia permission prompt).

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

const TURN_WATCHDOG_MS = 90000;

let port = null;
let nextReqId = 1;
const pending = new Map();
let reconnectTimer = null;
let reconnectAttempt = 0;
let historyRefresh = null;
let historyRefreshGeneration = 0;

let audioCtx = null;
let playbackTime = 0;
let playbackRate = 1;
const playbackSources = new Set();

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
