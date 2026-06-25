// agee - content script. Owns the on-page surface, perceives the page, executes actions.

(() => {
  const AGGIE_ROOT_ID = "agee-root";
  const existingAggies = () => Array.from(document.querySelectorAll(`#${AGGIE_ROOT_ID}`));
  const pruneDuplicateAggies = () => {
    const nodes = existingAggies();
    const keep = nodes.find((node) => node.querySelector("#agee-launcher")) || nodes[0] || null;
    for (const node of nodes) {
      if (node !== keep) node.remove();
    }
  };

  if (window.top !== window) return;
  if (window.__ageeLoaded) {
    pruneDuplicateAggies();
    return;
  }
  window.__ageeLoaded = true;
  existingAggies().forEach((node) => node.remove());

  // ---- Overlay UI -------------------------------------------------------
  let root,
    launcher,
    panel,
    input,
    voiceButton,
    stopButton,
    log,
    pendingConfirm = null,
    open = false,
    voiceState,
    transcriptEl,
    liveVoice = null,
    surfacePhase = "idle",
    listening = false,
    ambientState = "off",
    // Conversation mode: once you start talking, the mark keeps listening after
    // each reply so it works like speaking, not click-to-send. Stop ends it.
    conversationActive = false,
    dragState = null,
    clickTimer = null,
    holdToTalkTimer = null,
    holdToTalkActive = false,
    holdToTalkPointerId = null,
    doubleClickHoldPending = false,
    lastLauncherTap = null,
    // The Aggie mark stays where the user drops it and reacts visually to state.
    // audioCtx is created lazily when explicit voice playback needs it.
    audioCtx = null;
  const assistantPlaybackSources = new Set();
  const liveVoiceStates = new Set();
  const liveVoiceBySessionId = new Map();
  const DOUBLE_CLICK_HOLD_MS = 120;
  const LAUNCHER_DOUBLE_CLICK_MS = 280;
  const LAUNCHER_TAP_MAX_MS = 500;
  const LAUNCHER_DOUBLE_CLICK_SLOP = 28;
  const LAUNCHER_DRAG_SLOP = 4;
  let browserAgentOwner = null;
  let browserAgentOwnerState = "unknown";
  let assistantSpeechOverlap = false;
  let uiChimesEnabled = false;
  const DEV_RELOAD_DEFAULT_SERVER = "http://localhost:7777";
  const DEV_RELOAD_POLL_MS = 900;
  let devReloadTimer = null;
  let devReloadInFlight = false;
  let devReloadVersion = null;
  const PROFILE_LANGUAGE_NAMES = [
    "english",
    "spanish",
    "french",
    "german",
    "italian",
    "portuguese",
    "dutch",
    "russian",
    "polish",
    "ukrainian",
    "turkish",
    "arabic",
    "hebrew",
    "hindi",
    "bengali",
    "bangla",
    "urdu",
    "tamil",
    "telugu",
    "mandarin",
    "chinese",
    "cantonese",
    "japanese",
    "korean",
    "vietnamese",
    "thai",
    "indonesian",
    "malay",
    "filipino",
    "tagalog",
    "swahili",
    "amharic",
    "tigrinya",
    "tigrigna",
    "somali",
    "hausa",
    "yoruba",
    "igbo",
    "zulu",
    "afrikaans",
    "greek",
    "czech",
    "romanian",
    "hungarian",
    "swedish",
    "norwegian",
    "danish",
    "finnish",
    "persian",
    "farsi",
  ];
  const PROFILE_VOICE_NAMES = ["puck", "charon", "kore", "fenrir", "aoede", "leda", "orus", "zephyr"];
  let extensionContextInvalidated = false;

  function markExtensionContextInvalidated(error) {
    const message = String(error?.message || error || "");
    if (!/extension context invalidated|context invalidated/i.test(message)) return false;
    extensionContextInvalidated = true;
    return true;
  }

  function canCallExtensionApi() {
    if (extensionContextInvalidated) return false;
    try {
      if (typeof chrome === "undefined") {
        extensionContextInvalidated = true;
        return false;
      }
      if (!chrome?.runtime?.id) {
        extensionContextInvalidated = true;
        return false;
      }
      return true;
    } catch (error) {
      markExtensionContextInvalidated(error);
      return false;
    }
  }

  function safeRuntimeSendMessage(message) {
    if (!canCallExtensionApi() || !chrome?.runtime?.sendMessage) return Promise.resolve(null);
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch((error) => {
        if (markExtensionContextInvalidated(error)) return null;
        throw error;
      });
    } catch (error) {
      if (markExtensionContextInvalidated(error)) return Promise.resolve(null);
      return Promise.reject(error);
    }
  }

  function safeStorageLocalGet(defaults) {
    if (!canCallExtensionApi() || !chrome?.storage?.local?.get) return Promise.resolve(defaults);
    try {
      return Promise.resolve(chrome.storage.local.get(defaults)).catch((error) => {
        if (markExtensionContextInvalidated(error)) return defaults;
        throw error;
      });
    } catch (error) {
      if (markExtensionContextInvalidated(error)) return Promise.resolve(defaults);
      return Promise.reject(error);
    }
  }

  function safeStorageLocalSet(items) {
    if (!canCallExtensionApi() || !chrome?.storage?.local?.set) return Promise.resolve(null);
    try {
      return Promise.resolve(chrome.storage.local.set(items)).catch((error) => {
        if (markExtensionContextInvalidated(error)) return null;
        throw error;
      });
    } catch (error) {
      if (markExtensionContextInvalidated(error)) return Promise.resolve(null);
      return Promise.reject(error);
    }
  }

  function base64ToBuffer(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  // The voice path is icon-first. It uses state for launcher glow/audio routing,
  // not for a visible chat transcript:
  //   idle      - no voice session
  //   listening - mic open
  //   thinking  - utterance submitted, waiting on the gateway
  //   speaking  - reply is being spoken back
  let agentState = "idle";

  // The gateway may still identify each turn with a cue id, but the page surface
  // presents one current intent/result rather than a visible chat history.
  let cueSeq = 0;
  let currentCueId = null;
  const cues = new Map();
  const activeCues = new Set();
  const revokedCueIds = new Set();
  function build() {
    root = document.createElement("div");
    root.id = "agee-root";
    root.dataset.ageeOwner = browserAgentOwnerState;
    root.innerHTML = `
      <button id="agee-launcher" type="button" title="Click for chat · drag to move · double-click and hold to talk" aria-label="Aggie">
        <span class="agee-ring" aria-hidden="true"></span>
        <span class="agee-shadow" aria-hidden="true"></span>
        <img class="agee-bird" src="${chrome.runtime.getURL("moa-mark.png")}" alt="" draggable="false" />
      </button>
      <div id="agee-panel" role="dialog" aria-label="Aggie command">
        <div id="agee-voice-state" aria-hidden="true">
          <span id="agee-orb"></span>
          <span id="agee-transcript" aria-live="polite"></span>
        </div>
        <div id="agee-log" aria-hidden="true"></div>
        <div id="agee-bar">
          <span id="agee-dot"></span>
          <textarea id="agee-input" rows="1" placeholder="Ask Aggie" autocomplete="off" spellcheck="true"></textarea>
          <button id="agee-voice" type="button" title="Start voice" aria-label="Start voice"></button>
          <button id="agee-stop" type="button" title="Stop current task" aria-label="Stop current task">Stop</button>
        </div>
      </div>`;
    document.documentElement.appendChild(root);
    launcher = root.querySelector("#agee-launcher");
    panel = root.querySelector("#agee-panel");
    input = root.querySelector("#agee-input");
    voiceButton = root.querySelector("#agee-voice");
    stopButton = root.querySelector("#agee-stop");
    log = root.querySelector("#agee-log");
    voiceState = root.querySelector("#agee-voice-state");
    transcriptEl = root.querySelector("#agee-transcript");

    restoreLauncherPosition();
    restoreUiChimePreference();
    // Launcher gestures intentionally match the Android orb:
    //   single click            -> chat menu
    //   first press + movement  -> drag the mark
    //   double-click and hold   -> manual push-to-talk
    launcher.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    launcher.addEventListener("pointerdown", startLauncherDrag);
    window.addEventListener("resize", () => {
      if (open) positionPanel();
    });

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        // The composer is a draft buffer. Fire the message without clearing the
        // field so whatever the user was typing stays visible while it streams.
        submitInstruction(text);
      } else if (e.key === "Escape") {
        closeTextSurface();
      }
    });
    input.addEventListener("input", () => {
      resizeInput();
      setSurfacePhase("editing");
    });

    voiceButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTextSurface({ fresh: false });
      primeAudio();
      toggleVoice();
    });

    stopButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      safeRuntimeSendMessage({ cmd: "cancel" });
      stopAllLiveVoiceTurns("cancel");
      stopSpeaking();
    });

    // Explicit voice playback primes audio from the voice path itself.
  }

  function restoreUiChimePreference() {
    safeStorageLocalGet({ ageeUiChimesEnabled: false }).then(({ ageeUiChimesEnabled }) => {
      uiChimesEnabled = ageeUiChimesEnabled === true;
    }).catch(() => {});
  }

  function restoreLauncherPosition() {
    safeStorageLocalGet({ ageeLauncherPosition: null }).then(({ ageeLauncherPosition }) => {
      if (!launcher || !ageeLauncherPosition) return;
      const { x, y } = ageeLauncherPosition;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      placeLauncher(x, y, false);
    }).catch(() => {});
  }

  function placeLauncher(x, y, persist) {
    if (!launcher) return;
    const rect = launcher.getBoundingClientRect();
    const nextX = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const nextY = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    launcher.style.left = `${nextX}px`;
    launcher.style.top = `${nextY}px`;
    launcher.style.right = "auto";
    launcher.style.bottom = "auto";
    if (open) positionPanel(); // keep the surface anchored if the mark moves
    if (persist) safeStorageLocalSet({ ageeLauncherPosition: { x: nextX, y: nextY } }).catch(() => {});
  }

  function startLauncherDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = launcher.getBoundingClientRect();
    dragState = {
      pointerId: e.pointerId,
      startTime: e.timeStamp,
      startX: e.clientX,
      startY: e.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    if (isLauncherSecondTap(e)) {
      cancelLauncherTap();
      scheduleLauncherDoubleClickHold(e);
    } else {
      cancelLauncherTap();
      doubleClickHoldPending = false;
      holdToTalkActive = false;
      holdToTalkPointerId = null;
    }
    launcher.setPointerCapture(e.pointerId);
    launcher.addEventListener("pointermove", moveLauncherDrag);
    launcher.addEventListener("pointerup", stopLauncherDrag);
    launcher.addEventListener("pointercancel", stopLauncherDrag);
  }

  function moveLauncherDrag(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    if (holdToTalkActive && e.pointerId === holdToTalkPointerId) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (Math.abs(dx) + Math.abs(dy) > LAUNCHER_DRAG_SLOP) {
      dragState.moved = true;
      cancelLauncherDoubleClickHold();
    }
    placeLauncher(dragState.left + dx, dragState.top + dy, false);
  }

  function stopLauncherDrag(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const wasHoldToTalk = holdToTalkActive && e.pointerId === holdToTalkPointerId;
    const wasPendingDoubleClickHold = doubleClickHoldPending && e.pointerId === holdToTalkPointerId;
    const moved = dragState.moved;
    const downMs = e.timeStamp - dragState.startTime;
    dragState = null;
    launcher.releasePointerCapture(e.pointerId);
    launcher.removeEventListener("pointermove", moveLauncherDrag);
    launcher.removeEventListener("pointerup", stopLauncherDrag);
    launcher.removeEventListener("pointercancel", stopLauncherDrag);
    cancelLauncherDoubleClickHold();
    if (wasHoldToTalk) {
      finishLauncherPushToTalk();
      return;
    }
    if (wasPendingDoubleClickHold) return;
    if (moved) {
      const rect = launcher.getBoundingClientRect();
      placeLauncher(rect.left, rect.top, true);
      return;
    }
    if (e.type === "pointercancel" || downMs > LAUNCHER_TAP_MAX_MS) return;
    scheduleLauncherTap(e);
  }

  function isLauncherSecondTap(e) {
    if (!lastLauncherTap || !clickTimer) return false;
    const elapsed = e.timeStamp - lastLauncherTap.time;
    if (elapsed < 0 || elapsed > LAUNCHER_DOUBLE_CLICK_MS) return false;
    const dx = e.clientX - lastLauncherTap.x;
    const dy = e.clientY - lastLauncherTap.y;
    return (dx * dx + dy * dy) <= LAUNCHER_DOUBLE_CLICK_SLOP * LAUNCHER_DOUBLE_CLICK_SLOP;
  }

  function scheduleLauncherTap(e) {
    cancelLauncherTap();
    lastLauncherTap = { time: e.timeStamp, x: e.clientX, y: e.clientY };
    clickTimer = setTimeout(() => {
      clickTimer = null;
      const tap = lastLauncherTap;
      lastLauncherTap = null;
      if (tap) openTextSurface({ fresh: false });
    }, LAUNCHER_DOUBLE_CLICK_MS);
  }

  function cancelLauncherTap() {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    lastLauncherTap = null;
  }

  function scheduleLauncherDoubleClickHold(e) {
    cancelLauncherDoubleClickHold();
    doubleClickHoldPending = true;
    holdToTalkPointerId = e.pointerId;
    holdToTalkTimer = setTimeout(() => {
      holdToTalkTimer = null;
      if (!doubleClickHoldPending || !dragState || dragState.pointerId !== e.pointerId || dragState.moved || holdToTalkActive) return;
      doubleClickHoldPending = false;
      holdToTalkActive = true;
      startLauncherPushToTalk();
    }, DOUBLE_CLICK_HOLD_MS);
  }

  function cancelLauncherDoubleClickHold() {
    if (holdToTalkTimer) {
      clearTimeout(holdToTalkTimer);
      holdToTalkTimer = null;
    }
    if (!holdToTalkActive) {
      holdToTalkPointerId = null;
      doubleClickHoldPending = false;
    }
  }

  function startLauncherPushToTalk() {
    openTextSurface({ fresh: false });
    primeAudio();
    if (liveVoice) stopLiveVoiceTurn("cancel");
    startLiveVoiceTurn({
      preserveAssistantPlayback: assistantSpeechOverlap === true,
      conversation: false,
      autoCommit: false,
    });
  }

  function finishLauncherPushToTalk() {
    holdToTalkActive = false;
    holdToTalkPointerId = null;
    if (liveVoice && listening) {
      commitLiveVoiceTurn();
    }
  }

  function toggle(force) {
    const was = open;
    open = typeof force === "boolean" ? force : !open;
    if (!root) build();
    root.classList.toggle("agee-open", open);
    if (open) {
      positionPanel(); // anchor the surface to the mark, not a fixed corner
      if (!was) chime("wake");
      setTimeout(() => input.focus(), 0);
    }
  }

  // Anchor the panel to the floating mark so the input opens right where the
  // agent is. It opens above the mark and grows upward (its bottom stays pinned
  // just above the mark), so streamed results stack up where the input sits. If
  // the mark is near the top of the screen, it opens below instead.
  function positionPanel() {
    if (!panel || !launcher) return;
    const lr = launcher.getBoundingClientRect();
    const gap = 12;
    const pw = panel.offsetWidth || Math.min(540, window.innerWidth - 24);
    let left = lr.left + lr.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    panel.style.left = `${left}px`;
    panel.style.right = "auto";
    if (lr.top > 140) {
      panel.style.bottom = `${Math.max(8, window.innerHeight - lr.top + gap)}px`;
      panel.style.top = "auto";
    } else {
      panel.style.top = `${lr.bottom + gap}px`;
      panel.style.bottom = "auto";
    }
  }

  function openTextSurface({ fresh = false } = {}) {
    if (!root) build();
    toggle(true);
    if (fresh) {
      setInputText("");
      setSurfacePhase("editing");
    }
    setTimeout(() => input.focus(), 0);
  }

  function closeTextSurface() {
    toggle(false);
    if (surfacePhase !== "pending") setSurfacePhase("idle");
  }

  function setSurfacePhase(next) {
    surfacePhase = next;
    if (!root) return;
    for (const phase of ["idle", "editing", "pending", "result", "error"]) {
      root.classList.toggle(`agee-phase-${phase}`, phase === next);
    }
    // The composer stays editable through every phase. Answers live in the cue
    // cards above, never in the input, so a running turn never locks typing.
    if (input) input.readOnly = false;
  }

  // Show the result stack whenever it holds anything (running, done, error, or
  // confirm rows), so answers sit above the composer until their linger timer
  // removes them.
  function syncLogVisibility() {
    if (!root || !log) return;
    const hasVisibleWork = log.children.length > 0;
    root.classList.toggle("agee-has-log", hasVisibleWork);
  }

  function setInputText(text, { select = false } = {}) {
    if (!input) return;
    input.value = String(text || "");
    resizeInput();
    if (select) {
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    }
  }

  function resizeInput() {
    if (!input) return;
    input.style.height = "auto";
    const max = Math.max(96, Math.round(window.innerHeight * 0.32));
    input.style.height = `${Math.min(input.scrollHeight || 0, max)}px`;
  }

  function makeRow(who, text) {
    const row = document.createElement("div");
    row.className = `agee-row agee-${who}`;
    row.textContent = text;
    return row;
  }

  function addLog(who, text) {
    if (!log) return;
    log.appendChild(makeRow(who, text));
    syncLogVisibility();
    log.scrollTop = log.scrollHeight;
  }

  function askInlineConfirm(text) {
    if (!log) return Promise.resolve(false);
    if (pendingConfirm) pendingConfirm(false);
    reactLauncher("attention"); // a question needs the user: ring for attention
    openTextSurface({ fresh: false });
    root?.classList.add("agee-confirming");
    return new Promise((resolve) => {
      pendingConfirm = resolve;
      const row = document.createElement("div");
      row.className = "agee-row agee-confirm";
      row.innerHTML = `
        <div class="agee-confirm-text"></div>
        <div class="agee-confirm-actions">
          <button type="button" data-agee-confirm="yes">Allow</button>
          <button type="button" data-agee-confirm="no">Cancel</button>
        </div>`;
      row.querySelector(".agee-confirm-text").textContent = text || "Allow Aggie to continue?";
      row.addEventListener("click", (event) => {
        const button = event.target.closest("[data-agee-confirm]");
        if (!button) return;
        const ok = button.getAttribute("data-agee-confirm") === "yes";
        pendingConfirm = null;
        row.remove();
        root?.classList.remove("agee-confirming");
        resolve(ok);
      });
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    });
  }

  let lastTerminal = ""; // "done" | "error" — shown on the dot when nothing is running

  function anyActive() {
    return activeCues.size > 0;
  }

  // The launcher dot is "running" while any cue is in flight, otherwise it shows
  // the most recent terminal state. The Stop button is visible only while busy.
  function refreshStatus() {
    const dot = root && root.querySelector("#agee-dot");
    if (dot) dot.className = anyActive() ? "running" : lastTerminal;
    if (stopButton) stopButton.classList.toggle("visible", anyActive());
    // The mark glows while it is working so the user can tell it is busy even
    // with the panel closed.
    if (launcher) launcher.classList.toggle("agee-busy", anyActive());
  }

  // ---- Cue cards --------------------------------------------------------
  // Each cue gets a card: the user's line plus a live status line that moves
  // from "thinking…" through progress to a final answer/error.
  function newCueId() {
    cueSeq += 1;
    return `c_${cueSeq}_${Date.now().toString(36)}`;
  }

  // Cards stack as the user keeps sending. Drop the oldest finished ones past the
  // cap so the log stays bounded; a running card is never pruned.
  const MAX_CUE_CARDS = 12;
  function pruneCueCards() {
    if (!log) return;
    const cards = [...log.querySelectorAll(".agee-cue")];
    let removable = cards.length - MAX_CUE_CARDS;
    for (const card of cards) {
      if (removable <= 0) break;
      const id = card.dataset.cue;
      if (activeCues.has(id)) continue;
      removeCueCard(id);
      removable -= 1;
    }
  }

  // The surface is not a chat. A card lives only while its turn is in flight, then
  // lingers just long enough to read the answer and fades out. A running card is
  // never auto-dismissed — it waits for its response.
  const CUE_LINGER_DONE_MS = 6000;
  const CUE_LINGER_ERROR_MS = 9000;

  function scheduleCueDismiss(cueId, kind) {
    const entry = cues.get(cueId);
    if (!entry) return;
    if (entry.dismissTimer) clearTimeout(entry.dismissTimer);
    const delay = kind === "error" ? CUE_LINGER_ERROR_MS : CUE_LINGER_DONE_MS;
    entry.dismissTimer = setTimeout(() => dismissCue(cueId), delay);
  }

  // Fade a finished card out, then remove it. In-flight cards are left alone.
  function dismissCue(cueId) {
    const entry = cues.get(cueId);
    if (!entry || activeCues.has(cueId)) return;
    if (entry.dismissTimer) {
      clearTimeout(entry.dismissTimer);
      entry.dismissTimer = null;
    }
    const card = entry.cardEl;
    cues.delete(cueId);
    if (!card) return;
    card.classList.add("agee-cue-leaving");
    const finalize = () => {
      card.remove();
      syncLogVisibility();
    };
    card.addEventListener("animationend", finalize, { once: true });
    setTimeout(finalize, 400); // fallback if the animation never fires
  }

  // Remove a card right now, no fade. Used by prune and when a new turn arrives.
  function removeCueCard(cueId) {
    const entry = cues.get(cueId);
    if (entry?.dismissTimer) clearTimeout(entry.dismissTimer);
    cues.delete(cueId);
    activeCues.delete(cueId);
    entry?.cardEl?.remove();
    log?.querySelector(`.agee-cue[data-cue="${cueId}"]`)?.remove();
    syncLogVisibility();
  }

  function rememberRevokedCue(cueId) {
    if (!cueId) return;
    revokedCueIds.add(cueId);
    setTimeout(() => revokedCueIds.delete(cueId), 30000);
  }

  // Sending a new message clears whatever already finished, so only live turns
  // stay on screen. Running cards are kept — several intents can run at once.
  function clearFinishedCues() {
    if (!log) return;
    for (const card of [...log.querySelectorAll(".agee-cue")]) {
      const id = card.dataset.cue;
      if (activeCues.has(id)) continue;
      removeCueCard(id);
    }
    syncLogVisibility();
  }

  function createCue(cueId, label, { presentation = "card" } = {}) {
    if (presentation === "icon") {
      currentCueId = cueId;
      cues.set(cueId, { presentation, label: String(label || "") });
      activeCues.add(cueId);
      refreshStatus();
      return;
    }
    materializeCue(cueId, label, "thinking...");
  }

  function materializeCue(cueId, label, statusText = "thinking...") {
    if (!log) return null;
    let entry = cues.get(cueId);
    if (entry?.cardEl && entry?.statusEl) return entry;
    clearFinishedCues(); // a new turn wipes whatever already answered
    currentCueId = cueId;
    const card = document.createElement("div");
    card.className = "agee-cue agee-cue-running";
    card.dataset.cue = cueId;
    const you = document.createElement("div");
    you.className = "agee-row agee-you";
    you.textContent = String(label || entry?.label || "Aggie");
    const status = document.createElement("div");
    status.className = "agee-cue-status";
    status.textContent = statusText || "";
    card.appendChild(you);
    card.appendChild(status);
    log.appendChild(card);
    entry = {
      ...(entry || {}),
      statusEl: status,
      cardEl: card,
      labelEl: you,
      presentation: "card",
      label: you.textContent,
    };
    cues.set(cueId, entry);
    activeCues.add(cueId);
    pruneCueCards();
    syncLogVisibility();
    log.scrollTop = log.scrollHeight;
    refreshStatus();
    return entry;
  }

  function ensureVoiceCueCard(state, label = "", statusText = "") {
    if (!state?.cueId) return null;
    const entry = cues.get(state.cueId);
    if (entry?.statusEl) {
      if (label) updateCueLabel(state.cueId, label);
      if (statusText) entry.statusEl.textContent = statusText;
      return entry;
    }
    return materializeCue(state.cueId, label || state.transcript || "Voice", statusText || "");
  }

  function updateCueLabel(cueId, text) {
    const value = String(text || "").trim();
    if (!value) return;
    const entry = cues.get(cueId);
    if (entry && !entry.labelEl) entry.label = value;
    if (entry?.labelEl) entry.labelEl.textContent = value;
  }

  // Update a cue's status line. kind: "running" | "done" | "error".
  function updateCue(cueId, text, kind) {
    if (cueId && revokedCueIds.has(cueId)) return;
    let entry = cues.get(cueId);
    // A message for an unknown cue (e.g. server-generated id) falls back to a row.
    // Tag the terminal kind so harnesses can distinguish final state from
    // interim progress in the hidden one-turn ledger.
    if (!entry) {
      if (cueId && currentCueId && cueId !== currentCueId) return;
      addLog(kind === "error" ? "error" : kind === "done" ? "done" : "agee", text);
      if (kind === "done" || kind === "error") {
        lastTerminal = kind;
        refreshStatus();
      }
      return;
    }
    if (!entry.statusEl) {
      if (kind === "error") {
        entry = materializeCue(cueId, entry.label || "Voice", text || "Voice failed.");
      } else if (kind === "done") {
        activeCues.delete(cueId);
        cues.delete(cueId);
        lastTerminal = kind;
        refreshStatus();
        syncLogVisibility();
        return;
      } else {
        refreshStatus();
        return;
      }
    }
    if (!entry?.statusEl) return;
    if (typeof text === "string" && text) entry.statusEl.textContent = text;
    if (kind === "done" || kind === "error") {
      entry.cardEl.className = `agee-cue agee-cue-${kind}`;
      activeCues.delete(cueId);
      lastTerminal = kind;
      scheduleCueDismiss(cueId, kind); // served → linger briefly, then fade out
    }
    refreshStatus();
    if (log) log.scrollTop = log.scrollHeight;
  }

  function visibleErrorMessage(message) {
    const text = String(message || "").trim();
    if (!text) return "";
    if (/extension context invalidated/i.test(text)) return "";
    if (/failed to complete turn:\s*gemini-live generation was interrupted/i.test(text)) return "";
    if (/gemini-live generation was interrupted/i.test(text)) return "";
    return text;
  }

  function showCueError(cueId, message, { react = true } = {}) {
    const text = visibleErrorMessage(message);
    if (!text) {
      removeCueCard(cueId);
      refreshStatus();
      return false;
    }
    updateCue(cueId, text, "error");
    if (react) reactLauncher("error");
    return true;
  }

  function stopSpeaking() {
    stopAllAssistantPlayback();
    if (agentState === "speaking") setAgentState("idle");
  }

  function trackLiveVoiceState(state) {
    if (!state) return;
    liveVoiceStates.add(state);
  }

  function attachLiveVoiceSession(state, voiceSessionId) {
    if (!state) return;
    if (state.voiceSessionId) liveVoiceBySessionId.delete(state.voiceSessionId);
    state.voiceSessionId = voiceSessionId || null;
    if (state.voiceSessionId) {
      liveVoiceBySessionId.set(state.voiceSessionId, state);
      safeRuntimeSendMessage({ cmd: "voiceSessionAttach", voiceSessionId: state.voiceSessionId })
        .catch(() => {});
    }
  }

  function untrackLiveVoiceState(state) {
    if (!state) return;
    liveVoiceStates.delete(state);
    if (state.voiceSessionId) liveVoiceBySessionId.delete(state.voiceSessionId);
    if (liveVoice === state) liveVoice = null;
  }

  function isLiveVoiceStateActive(state) {
    return !!state && liveVoiceStates.has(state);
  }

  // ---- The mark: sound, reactions ---------------------------------------
  // A short synthesized chime so something *rings* when a turn lands. No asset,
  // no network: two quick sine notes. "done" rises (happy), "error" falls,
  // "attention" is a single insistent note (a question needs the user).
  function primeAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch {}
  }

  function chime(kind = "done") {
    if (!uiChimesEnabled) return;
    primeAudio();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const notes =
      kind === "error" ? [493.9, 329.6]
      : kind === "attention" ? [587.3, 587.3]
      : kind === "wake" ? [523.25, 783.99] // soft rising fifth, C5 → G5: a friendly "ready"
      : [659.3, 880.0];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.13;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.16, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    });
  }

  // Make the launcher visibly react: a one-shot body animation plus an expanding
  // ring, plus the chime. Called when a cue finishes, errors, or needs the user.
  function reactLauncher(kind = "done") {
    if (!launcher) return;
    const ring = launcher.querySelector(".agee-ring");
    launcher.classList.remove("agee-hop", "agee-shake", "agee-attention");
    void launcher.offsetWidth; // restart the animation even on back-to-back events
    launcher.classList.add(kind === "error" ? "agee-shake" : kind === "attention" ? "agee-attention" : "agee-hop");
    if (ring) {
      ring.dataset.kind = kind;
      ring.classList.remove("agee-ring-go");
      void ring.offsetWidth;
      ring.classList.add("agee-ring-go");
    }
    chime(kind);
  }

  // Fire a cue. Never blocks on a prior cue — that is the whole point: the user
  // keeps talking, each utterance becomes its own concurrent lane.
  function submitInstruction(instruction, displayText = instruction) {
    if (!instruction) return;
    const cueId = newCueId();
    openTextSurface({ fresh: false });
    createCue(cueId, displayText, { presentation: "card" });
    // Keep the composer as a draft buffer. Responses render above it and must
    // not clear or replace whatever the user is typing.
    setSurfacePhase("editing");
    // A voice-launched turn keeps the agent surface up and moves it to thinking;
    // a typed command leaves the voice surface untouched.
    if (agentState !== "idle") {
      setTranscript(displayText);
      setAgentState("thinking");
    }
    input.focus();
    safeRuntimeSendMessage({ cmd: "run", instruction, cueId }).then(() => {
      if (extensionContextInvalidated) removeCueCard(cueId);
    }).catch((error) => {
      showCueError(cueId, error?.message || error, { react: false });
    });
  }

  function describePage() {
    const cueId = newCueId();
    openTextSurface({ fresh: false });
    createCue(cueId, "Describe this page", { presentation: "card" });
    safeRuntimeSendMessage({ cmd: "describe", cueId }).then(() => {
      if (extensionContextInvalidated) removeCueCard(cueId);
    }).catch((error) => {
      showCueError(cueId, error?.message || error, { react: false });
    });
  }

  function setVoiceState(next) {
    listening = next;
    if (voiceButton) {
      voiceButton.classList.toggle("listening", listening);
      voiceButton.textContent = "";
      voiceButton.title = listening ? "Send voice" : "Start voice";
      voiceButton.setAttribute("aria-label", listening ? "Send voice" : "Start voice");
    }
  }

  // Drive voice state on the root. The top strip stays hidden; live transcript
  // and assistant text render in cue cards above the input.
  function setAgentState(next) {
    agentState = next;
    if (!root) return;
    for (const s of ["idle", "listening", "thinking", "speaking"]) {
      root.classList.toggle(`agee-state-${s}`, s === next);
    }
    const voicing = next !== "idle";
    root.classList.toggle("agee-voicing", voicing);
    if (voiceState) voiceState.setAttribute("aria-hidden", "true");
    if (next === "idle") setTranscript("");
  }

  // Keep the legacy transcript node inert; visible voice feedback lives in
  // cue cards above the input so the draft buffer remains untouched.
  function setTranscript(text, interim = false) {
    if (!transcriptEl) return;
    transcriptEl.textContent = text || "";
    transcriptEl.classList.toggle("agee-interim", !!interim && !!text);
  }

  function setAmbientState(next) {
    ambientState = next === "on" ? "on" : "off";
    if (root) root.classList.toggle("agee-ambient", ambientState === "on");
  }

  async function startLiveVoiceTurn(options = {}) {
    const preserveAssistantPlayback = options.preserveAssistantPlayback === true || assistantSpeechOverlap === true;
    if (!preserveAssistantPlayback) {
      stopSpeaking();
    }
    openTextSurface({ fresh: false });
    conversationActive = true;
    if (options.conversation === false) conversationActive = false;
    const cueId = newCueId();
    createCue(cueId, "", { presentation: "icon" });
    setVoiceState(true);
    setAgentState("listening");
    setTranscript("");

    const state = {
      cueId,
      turnId: `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      voiceSessionId: null,
      sessionReady: false,
      committed: false,
      playbackTime: 0,
      playbackSources: new Set(),
      assistantText: "",
      transcript: "",
      gatewayRouted: false,
      assistantSpeechOverlap: preserveAssistantPlayback,
    };
    trackLiveVoiceState(state);
    liveVoice = state;

    try {
      primeAudio();
      if (!audioCtx) throw new Error("Web Audio is not available in this browser.");

      const session = await safeRuntimeSendMessage({
        cmd: "voiceSessionStart",
        cueId,
        turnId: state.turnId,
        assistantOverlap: assistantSpeechOverlap === true,
        capture: "extension-offscreen",
        autoCommit: options.autoCommit !== false,
      });
      if (extensionContextInvalidated) {
        stopLiveVoiceState(state, "context invalidated");
        setVoiceState(false);
        if (agentState !== "idle") setAgentState("idle");
        return;
      }
      if (!session?.ok || !session.voiceSessionId) {
        throw new Error(session?.error || "gateway did not open a voice session");
      }
      attachLiveVoiceSession(state, session.voiceSessionId);
      if (state.commitWhenReady) commitLiveVoiceTurn();
    } catch (error) {
      finishLiveVoiceError(state, String(error?.message || error));
    }
  }

  function handleLiveVoiceMessage(state, payload) {
    if (payload?.audio) {
      playLiveAssistantPcm(state, base64ToBuffer(payload.audio));
      return;
    }
    if (payload?.data instanceof ArrayBuffer) {
      playLiveAssistantPcm(state, payload.data);
      return;
    }
    if (payload?.data instanceof Blob) {
      payload.data.arrayBuffer().then((buffer) => playLiveAssistantPcm(state, buffer));
      return;
    }

    let msg;
    if (payload?.event && typeof payload.event === "object") {
      msg = payload.event;
    } else if (payload && typeof payload === "object" && payload.type) {
      msg = payload;
    } else {
      try {
        msg = JSON.parse(String(payload?.data || payload || "{}"));
      } catch {
        return;
      }
    }
    if (!isLiveVoiceStateActive(state) || state.gatewayRouted) return;
    const isCurrentTurn = liveVoice === state;

    if (msg.type === "session_ready") {
      state.sessionReady = true;
      updateCue(state.cueId, "", "running");
      return;
    }
    if (msg.type === "profile_applied") {
      return;
    }
    if (msg.type === "revoked") {
      revokeLiveVoiceState(state, msg.reason || "revoked");
      return;
    }
    if (msg.type === "transcript_partial" || msg.type === "transcript_final") {
      const text = String(msg.text || "").trim();
      if (!text) return;
      state.transcript = text;
      if (isCurrentTurn) setTranscript(text, msg.type === "transcript_partial");
      updateCueLabel(state.cueId, text);
      ensureVoiceCueCard(state, text, "");
      if (msg.type === "transcript_final" && isCurrentTurn && applySpeechOverlapPolicyFromTranscript(state, text)) {
        return;
      }
      if (msg.type === "transcript_final" && isCurrentTurn && shouldRouteLiveTranscriptThroughGateway(text)) {
        routeLiveTranscriptThroughGateway(state, text);
      }
      return;
    }
    if (msg.type === "assistant_text") {
      const text = String(msg.text || "").trim();
      if (!text) return;
      state.assistantText = text;
      ensureVoiceCueCard(state, state.transcript || "Voice", text);
      updateCue(state.cueId, text, "running");
      return;
    }
    if (msg.type === "assistant_audio_start") {
      if (isCurrentTurn) {
        setVoiceState(false);
        setAgentState("speaking");
      }
      state.playbackTime = Math.max(audioCtx?.currentTime || 0, state.playbackTime || 0) + 0.04;
      return;
    }
    if (msg.type === "assistant_audio_done") {
      return;
    }
    if (msg.type === "turn_done") {
      finishLiveVoiceDone(state);
      return;
    }
    if (msg.type === "error") {
      if (msg.recoverable === false || msg.code === "microphone_capture_failed") {
        finishLiveVoiceError(state, msg.message || "Live voice microphone capture failed.");
        return;
      }
      // A turn that dies mid-generation ("failed to complete turn: ...") is not a
      // dead end: the gateway has already stored the partial turn and will replay
      // it into the next session. Recover silently instead of surfacing it.
      recoverLiveVoiceTurn(state, msg.message || "live voice error");
      return;
    }
    if (msg.type === "connection_closed") {
      recoverLiveVoiceTurn(state, "connection closed");
    }
  }

  function playLiveAssistantPcm(state, buffer) {
    if (!buffer || !buffer.byteLength) return;
    if (!isLiveVoiceStateActive(state)) return;
    primeAudio();
    if (!audioCtx) return;
    const pcm = new Int16Array(buffer);
    const audioBuffer = audioCtx.createBuffer(1, pcm.length, 16000);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);
    state.playbackSources.add(source);
    assistantPlaybackSources.add(source);
    source.onended = () => {
      state.playbackSources.delete(source);
      assistantPlaybackSources.delete(source);
    };
    const startAt = Math.max(audioCtx.currentTime + 0.02, state.playbackTime || 0);
    source.start(startAt);
    state.playbackTime = startAt + audioBuffer.duration;
  }

  async function commitLiveVoiceTurn() {
    const state = liveVoice;
    if (!state || !isLiveVoiceStateActive(state)) return;
    state.committed = true;
    stopLiveCapture(state);
    setVoiceState(false);
    setAgentState("thinking");
    setTranscript(state.transcript || "");
    if (state.transcript) ensureVoiceCueCard(state, state.transcript, "");
    updateCue(state.cueId, "", "running");
    if (state.voiceSessionId) {
      safeRuntimeSendMessage({
        cmd: "voiceSessionControl",
        voiceSessionId: state.voiceSessionId,
        message: { type: "commit_turn", turn_id: state.turnId },
      }).then((res) => {
        if (!res && extensionContextInvalidated) return;
        if (!res?.ok) finishLiveVoiceError(state, res?.error || "Live voice connection was not open.");
      }).catch((error) => finishLiveVoiceError(state, String(error?.message || error)));
    } else {
      state.commitWhenReady = true;
    }
  }

  function routeLiveTranscriptThroughGateway(state, transcript) {
    if (liveVoice !== state || !isLiveVoiceStateActive(state) || state.gatewayRouted) return;
    state.gatewayRouted = true;
    state.committed = true;
    stopLiveCapture(state);
    stopLivePlayback(state);
    setVoiceState(false);
    setAgentState("thinking");
    setTranscript(transcript);
    updateCueLabel(state.cueId, transcript);
    materializeCue(state.cueId, transcript, "updating settings...");
    sendLiveVoiceControl(state, { type: "cancel_turn", turn_id: state.turnId });
    closeLiveVoiceSession(state, "profile control routed to gateway");
    untrackLiveVoiceState(state);
    safeRuntimeSendMessage({ cmd: "run", instruction: transcript, cueId: state.cueId }).then(() => {
      if (extensionContextInvalidated) removeCueCard(state.cueId);
    }).catch((error) => {
      showCueError(state.cueId, error?.message || error);
      if (agentState === "thinking") setAgentState("idle");
    });
  }

  function stopLiveVoiceTurn(mode = "stop") {
    // Any explicit stop/cancel/error ends conversation mode so the mark does not
    // re-arm the mic after the current turn tears down.
    conversationActive = false;
    const state = liveVoice;
    if (!state) {
      setVoiceState(false);
      if (agentState !== "idle") setAgentState("idle");
      return;
    }
    stopLiveVoiceState(state, mode);
    setVoiceState(false);
    if (agentState !== "idle") setAgentState("idle");
  }

  function stopAllLiveVoiceTurns(mode = "stop") {
    conversationActive = false;
    for (const state of [...liveVoiceStates]) {
      stopLiveVoiceState(state, mode);
    }
    liveVoice = null;
    setVoiceState(false);
    if (agentState !== "idle") setAgentState("idle");
  }

  function revokeLiveVoiceState(state, _reason = "revoked") {
    conversationActive = false;
    stopLiveVoiceState(state, "revoked");
    setVoiceState(false);
    if (agentState !== "idle") setAgentState("idle");
  }

  function stopLiveVoiceState(state, mode = "stop") {
    if (!isLiveVoiceStateActive(state)) return;
    stopLiveCapture(state);
    stopLivePlayback(state);
    if (mode === "cancel") sendLiveVoiceControl(state, { type: "cancel_turn", turn_id: state.turnId });
    closeLiveVoiceSession(state, mode);
    if (mode === "revoked") {
      rememberRevokedCue(state.cueId);
      removeCueCard(state.cueId);
    }
    untrackLiveVoiceState(state);
  }

  function handleAgentRevoked(msg = {}) {
    conversationActive = false;
    window.__ageeLastAgentRevoked = {
      cueIds: Array.isArray(msg.cueIds) ? msg.cueIds : [],
      reason: String(msg.reason || ""),
      at: Date.now(),
    };
    if (root) {
      root.dataset.ageeOwner = "passive";
      root.dataset.ageeLastRevokedReason = String(msg.reason || "");
    }
    const cueIds = Array.isArray(msg.cueIds) ? msg.cueIds : [];
    for (const cueId of cueIds) {
      rememberRevokedCue(cueId);
      removeCueCard(cueId);
    }
    stopAllLiveVoiceTurns("revoked");
    stopSpeaking();
    setVoiceState(false);
    if (agentState !== "idle") setAgentState("idle");
    refreshStatus();
  }

  function handleBrowserAgentOwnerChanged(msg = {}) {
    browserAgentOwner = msg.owner || null;
    browserAgentOwnerState = msg.isOwner ? "active" : browserAgentOwner?.status === "cleared" ? "cleared" : "passive";
    window.__ageeBrowserAgentOwner = browserAgentOwner;
    window.__ageeBrowserAgentOwnerState = browserAgentOwnerState;
    if (!root) return;
    root.dataset.ageeOwner = browserAgentOwnerState;
    root.dataset.ageeOwnerStatus = browserAgentOwner?.status || "";
    root.dataset.ageeOwnerCue = browserAgentOwner?.cue_id || "";
    root.dataset.ageeOwnerResult = browserAgentOwner?.last_result || "";
  }

  function sendLiveVoiceControl(state, message) {
    if (!state?.voiceSessionId) return;
    safeRuntimeSendMessage({
      cmd: "voiceSessionControl",
      voiceSessionId: state.voiceSessionId,
      message,
    }).catch(() => {});
  }

  function closeLiveVoiceSession(state, reason) {
    if (!state?.voiceSessionId) return;
    const voiceSessionId = state.voiceSessionId;
    safeRuntimeSendMessage({
      cmd: "voiceSessionClose",
      voiceSessionId,
      reason,
    }).catch(() => {});
    liveVoiceBySessionId.delete(voiceSessionId);
    state.voiceSessionId = null;
  }

  function stopLiveCapture(state) {
    // Microphone capture is extension-owned in offscreen.js. Content script
    // stop paths still call this helper so older lifecycle code stays simple,
    // but the real capture teardown happens in background.js when the voice
    // session is committed, canceled, or closed.
  }

  function stopLivePlayback(state) {
    for (const source of state.playbackSources || []) {
      stopAssistantPlaybackSource(source);
    }
    state.playbackSources?.clear();
  }

  function stopAllAssistantPlayback() {
    for (const source of [...assistantPlaybackSources]) {
      stopAssistantPlaybackSource(source);
    }
    assistantPlaybackSources.clear();
  }

  function stopAssistantPlaybackSource(source) {
    assistantPlaybackSources.delete(source);
    try {
      source.stop();
    } catch {}
  }

  // A live turn can die mid-generation: the provider interrupts, the socket
  // drops, or the gateway sends "failed to complete turn". The gateway already
  // persists that partial turn and replays it inside the NEXT session's context
  // pack, so we never surface the failure or stop the conversation. We tear the
  // dead turn down quietly and start a fresh one on the same session id; the
  // model picks the thread back up with the partial it already produced. A
  // bounded guard keeps a genuinely broken gateway from respawning forever.
  let liveVoiceRecoveries = 0;
  let liveVoiceRecoveryWindowAt = 0;
  const LIVE_VOICE_MAX_RECOVERIES = 2;
  const LIVE_VOICE_RECOVERY_WINDOW_MS = 15000;

  function recoverLiveVoiceTurn(state, reason) {
    if (!isLiveVoiceStateActive(state)) return;
    const wasCurrentTurn = liveVoice === state;
    // Tear the dead turn down without a red cue or state churn.
    stopLiveCapture(state);
    stopLivePlayback(state);
    closeLiveVoiceSession(state, reason || "recovering");
    untrackLiveVoiceState(state);
    removeCueCard(state.cueId);

    if (!wasCurrentTurn) {
      return;
    }

    if (!conversationActive) {
      // The user already ended the conversation; just settle to idle.
      setVoiceState(false);
      if (agentState !== "idle") setAgentState("idle");
      return;
    }

    const now = Date.now();
    if (now - liveVoiceRecoveryWindowAt > LIVE_VOICE_RECOVERY_WINDOW_MS) {
      liveVoiceRecoveries = 0;
      liveVoiceRecoveryWindowAt = now;
    }
    liveVoiceRecoveries += 1;
    if (liveVoiceRecoveries > LIVE_VOICE_MAX_RECOVERIES) {
      // Respawning is not catching — the gateway is down. Surface it once.
      liveVoiceRecoveries = 0;
      conversationActive = false;
      reactLauncher("error");
      setVoiceState(false);
      if (agentState !== "idle") setAgentState("idle");
      return;
    }

    startLiveVoiceTurn({ preserveAssistantPlayback: assistantSpeechOverlap === true });
  }

  function finishLiveVoiceDone(state) {
    if (!isLiveVoiceStateActive(state)) return;
    const wasCurrentTurn = liveVoice === state;
    liveVoiceRecoveries = 0;
    const summary = state.assistantText || "Done.";
    ensureVoiceCueCard(state, state.transcript || "Voice", summary);
    updateCue(state.cueId, summary, "done");
    reactLauncher("done");
    stopLiveCapture(state);
    closeLiveVoiceSession(state, "turn done");
    untrackLiveVoiceState(state);
    if (!wasCurrentTurn) return;
    setVoiceState(false);
    // Wait for the spoken reply to finish playing, then either listen again (so
    // the user just keeps talking) or fall back to idle if the conversation was
    // stopped. Re-arming only after playback ends keeps the reply out of the mic.
    const delayMs = Math.max(0, ((state.playbackTime || 0) - (audioCtx?.currentTime || 0)) * 1000);
    setTimeout(() => {
      if (liveVoice) return;
      if (conversationActive) {
        startLiveVoiceTurn({ preserveAssistantPlayback: assistantSpeechOverlap === true });
        return;
      }
      if (agentState !== "idle") setAgentState("idle");
    }, delayMs + 120);
  }

  function finishLiveVoiceError(state, message) {
    if (!isLiveVoiceStateActive(state)) return;
    const shown = showCueError(state.cueId, message);
    if (liveVoice === state) {
      stopLiveVoiceTurn("error");
    } else {
      stopLiveVoiceState(state, "error");
    }
    if (!shown && agentState !== "idle") setAgentState("idle");
  }

  function toggleVoice() {
    if (liveVoice && listening) {
      commitLiveVoiceTurn();
      return;
    }
    if (liveVoice) {
      if (assistantSpeechOverlap === true && liveVoice.committed) {
        startLiveVoiceTurn({ preserveAssistantPlayback: true });
        return;
      }
      stopLiveVoiceTurn("cancel");
    }
    startLiveVoiceTurn({ preserveAssistantPlayback: assistantSpeechOverlap === true });
  }

  function toggleVoiceSession() {
    toggleVoice();
  }

  function shouldRouteLiveTranscriptThroughGateway(text) {
    return isProfileControlTranscript(text);
  }

  function applySpeechOverlapPolicyFromTranscript(state, text) {
    const policy = parseAssistantSpeechOverlapIntent(text);
    if (!policy) return false;

    assistantSpeechOverlap = policy.enabled;
    state.gatewayRouted = true;
    state.committed = true;
    stopLiveCapture(state);
    sendLiveVoiceControl(state, { type: "cancel_turn", turn_id: state.turnId });
    closeLiveVoiceSession(state, policy.enabled ? "assistant speech overlap enabled" : "assistant barge-in enabled");
    untrackLiveVoiceState(state);
    setVoiceState(false);
    setTranscript("");
    updateCueLabel(state.cueId, text);
    updateCue(
      state.cueId,
      policy.enabled
        ? "Background speech is on for this session."
        : "Barge-in is back on for this session.",
      "done"
    );
    reactLauncher("done");
    if (agentState !== "idle") setAgentState("idle");
    if (conversationActive) {
      setTimeout(() => {
        if (!liveVoice && conversationActive) {
          startLiveVoiceTurn({ preserveAssistantPlayback: assistantSpeechOverlap === true });
        }
      }, 120);
    }
    return true;
  }

  function parseAssistantSpeechOverlapIntent(text) {
    const lower = normalizeSpokenCommand(text);
    if (!lower) return null;
    const disable =
      lower.includes("turn barge in back on") ||
      lower.includes("barge in back on") ||
      lower.includes("stop talking when i talk") ||
      lower.includes("stop speaking when i speak") ||
      lower.includes("interrupt yourself when i talk") ||
      lower.includes("interrupt yourself when i speak") ||
      lower.includes("do not talk over me") ||
      lower.includes("dont talk over me");
    if (disable) return { enabled: false };

    const enable =
      lower.includes("continue talking even though i") ||
      lower.includes("keep talking even though i") ||
      lower.includes("continue talking while i") ||
      lower.includes("keep talking while i") ||
      lower.includes("keep speaking while i") ||
      lower.includes("continue speaking while i") ||
      lower.includes("talk in the background") ||
      lower.includes("speak in the background") ||
      lower.includes("keep talking in the background") ||
      lower.includes("do not interrupt yourself") ||
      lower.includes("don t interrupt yourself") ||
      lower.includes("dont interrupt yourself");
    return enable ? { enabled: true } : null;
  }

  function isProfileControlTranscript(text) {
    const lower = normalizeSpokenCommand(text);
    if (!lower) return false;
    return isPromptProfileControl(lower) || isIdentityProfileControl(lower) || isLanguageProfileControl(lower) || isVoiceProfileControl(lower);
  }

  function isPromptProfileControl(lower) {
    return lower.includes("what prompt") ||
      lower.includes("which prompt") ||
      lower.includes("current prompt") ||
      /\b(set|change|update)\b.*\b(system )?prompt\b/.test(lower);
  }

  function isIdentityProfileControl(lower) {
    return lower.includes("what is your name") ||
      lower.includes("what s your name") ||
      lower.includes("who are you") ||
      /\byour name\b\s*(is|should be|will be)\b/.test(lower) ||
      /\b(call|name) yourself\b/.test(lower) ||
      /\b(you are|youre)\b\s+(now\s+)?(called\s+|named\s+)?/.test(lower);
  }

  function isLanguageProfileControl(lower) {
    if (
      lower.includes("what language") ||
      lower.includes("which language") ||
      lower.includes("language is active") ||
      /\b(set|change|update|switch)\b.*\blanguage\b/.test(lower)
    ) {
      return true;
    }
    if (!containsProfileWord(lower, PROFILE_LANGUAGE_NAMES)) return false;
    return /\b(speak|talk|reply|respond|answer|say)\b/.test(lower) ||
      lower.includes(" only ") ||
      lower.startsWith("only ") ||
      lower.includes("do not switch") ||
      lower.includes("don t switch") ||
      lower.includes("dont switch") ||
      lower.includes("these languages") ||
      lower.includes("these two languages");
  }

  function isVoiceProfileControl(lower) {
    if (
      lower.includes("what voice") ||
      lower.includes("which voice") ||
      /\b(set|change|switch|use|make)\b.*\bvoice\b/.test(lower)
    ) {
      return true;
    }
    if (lower.includes("sound like") || lower.includes("speak like")) {
      return /\b(female|woman|girl|feminine|lady|male|man|guy|masculine|boy)\b/.test(lower) ||
        containsProfileWord(lower, PROFILE_VOICE_NAMES);
    }
    return containsProfileWord(lower, PROFILE_VOICE_NAMES) && /\b(use|switch|set|change)\b/.test(lower);
  }

  function normalizeSpokenCommand(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function containsProfileWord(lower, values) {
    return values.some((value) => lower.includes(value));
  }

  async function startDevReloadWatcher() {
    if (!canCallExtensionApi() || !chrome?.storage?.local) return;
    const configure = async () => {
      const cfg = await safeStorageLocalGet({
        ageeDevReloadEnabled: false,
        ageeDevReloadServer: DEV_RELOAD_DEFAULT_SERVER,
        ageeDevReloadVersion: null,
      });
      devReloadVersion = cfg.ageeDevReloadVersion == null ? null : Number(cfg.ageeDevReloadVersion);
      if (cfg.ageeDevReloadEnabled) {
        if (!devReloadTimer) {
          devReloadTimer = setInterval(() => pollDevReloadFromContent().catch(() => {}), DEV_RELOAD_POLL_MS);
        }
        pollDevReloadFromContent().catch(() => {});
      } else if (devReloadTimer) {
        clearInterval(devReloadTimer);
        devReloadTimer = null;
      }
    };

    if (chrome.storage.onChanged) {
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local") return;
          if (changes.ageeDevReloadEnabled || changes.ageeDevReloadServer || changes.ageeDevReloadVersion) {
            configure().catch(() => {});
          }
        });
      } catch (error) {
        markExtensionContextInvalidated(error);
      }
    }
    await configure();
  }

  async function pollDevReloadFromContent() {
    if (devReloadInFlight) return;
    devReloadInFlight = true;
    try {
      const cfg = await safeStorageLocalGet({
        ageeDevReloadEnabled: false,
        ageeDevReloadServer: DEV_RELOAD_DEFAULT_SERVER,
        ageeDevReloadVersion: null,
      });
      if (!cfg.ageeDevReloadEnabled) return;
      const server = String(cfg.ageeDevReloadServer || DEV_RELOAD_DEFAULT_SERVER).replace(/\/+$/, "");
      const resp = await fetch(`${server}/__agee-dev/version?ts=${Date.now()}`, { cache: "no-store" });
      if (!resp.ok) return;
      const info = await resp.json();
      const nextVersion = Number(info?.version || 0);
      const previousVersion = devReloadVersion || Number(cfg.ageeDevReloadVersion || 0) || null;
      if (!nextVersion) return;
      if (!previousVersion) {
        devReloadVersion = nextVersion;
        await safeStorageLocalSet({ ageeDevReloadVersion: nextVersion });
        return;
      }
      if (nextVersion === previousVersion) return;
      devReloadVersion = nextVersion;
      await safeRuntimeSendMessage({
        cmd: "devReloadExtension",
        source: "content-script",
        server,
        previousVersion,
        info,
      });
    } catch {
      // The dev server is optional and usually offline during normal browsing.
    } finally {
      devReloadInFlight = false;
    }
  }

  // ---- Hotkeys: Cmd/Ctrl+. = voice, Cmd/Ctrl+, = text ------------------
  // Two ways in, both hands-on-keyboard, no clicking:
  //   ⌘.  (or Ctrl+.)         → wake the agent and listen (speech); again to run
  //   ⌘,  (or Ctrl+,)         → open the text command field

  function isVoiceHotkey(e) {
    return (e.metaKey || e.ctrlKey) && e.key === ".";
  }

  function isTextHotkey(e) {
    return (e.metaKey || e.ctrlKey) && (e.key === "," || (!e.shiftKey && e.code === "Comma"));
  }

  window.addEventListener(
    "keydown",
    (e) => {
      // ⌘. → voice/speech.
      if (isVoiceHotkey(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (!root) build();
        toggleVoiceSession();
        return;
      }
      // ⌘, → text command field.
      if (isTextHotkey(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (!root) build();
        openTextSurface({ fresh: false });
        return;
      }
    },
    true
  );

  // ---- Perception -------------------------------------------------------
  const SELECTOR =
    'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [contenteditable=""], [contenteditable=true], [onclick]';
  const MAX_VISIBLE_TEXT_CHARS = 5200;
  const MAX_VISIBLE_TEXT_PARTS = 140;
  const TEXT_NODE_EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS"]);

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  }

  function cleanVisibleText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function textNodeVisible(node) {
    const parent = node?.parentElement;
    if (!parent || parent.closest("#agee-root") || TEXT_NODE_EXCLUDED_TAGS.has(parent.tagName)) return false;
    const text = cleanVisibleText(node.nodeValue);
    if (text.length < 2) return false;
    const s = getComputedStyle(parent);
    if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") return false;
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects());
      if (typeof range.detach === "function") range.detach();
      if (!rects.length) return visible(parent);
      return rects.some((r) => r.width >= 1 && r.height >= 1 && r.bottom >= 0 && r.top <= innerHeight && r.right >= 0 && r.left <= innerWidth);
    } catch {
      return visible(parent);
    }
  }

  function visiblePageText() {
    if (!document.body) return "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return textNodeVisible(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const parts = [];
    const seen = new Set();
    let chars = 0;
    let node;
    while ((node = walker.nextNode())) {
      const text = cleanVisibleText(node.nodeValue);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      parts.push(text);
      chars += text.length + 1;
      if (parts.length >= MAX_VISIBLE_TEXT_PARTS || chars >= MAX_VISIBLE_TEXT_CHARS) break;
    }
    return parts.join("\n").slice(0, MAX_VISIBLE_TEXT_CHARS);
  }

  function label(el) {
    if (!el) return "";
    const text =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      (el.value && el.type !== "password" ? el.value : "") ||
      el.innerText ||
      el.getAttribute("title") ||
      el.getAttribute("name") ||
      "";
    return text.replace(/\s+/g, " ").trim().slice(0, 80);
  }

  const RISKY_TEXT = /\b(delete|remove|submit|send|pay|purchase|buy|checkout|confirm|transfer|withdraw|archive|sign out|log out|logout)\b/i;

  function needsConfirmation(el, req) {
    if (req.action === "key" && (req.text || "Enter") === "Enter") {
      const active = document.activeElement;
      return !!active && active !== document.body;
    }
    if (!el) return false;
    if (req.action === "type" && el.getAttribute("type") === "password") return true;
    if (req.action !== "click") return false;
    return RISKY_TEXT.test(label(el));
  }

  let indexed = [];
  function snapshot() {
    indexed = [];
    const out = [];
    document.querySelectorAll(SELECTOR).forEach((el) => {
      if (el.closest("#agee-root")) return;
      if (!visible(el)) return;
      const i = indexed.length;
      indexed.push(el);
      out.push({ i, tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "", label: label(el) });
    });
    return { url: location.href, title: document.title, pageText: visiblePageText(), elements: out };
  }

  // ---- Action -----------------------------------------------------------
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function act(req) {
    const el = indexed[req.index];
    if (["click", "type", "clear", "select"].includes(req.action) && !el) {
      return { result: `no element at index ${req.index}` };
    }
    try {
      if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
      if (needsConfirmation(el, req) && !(await askInlineConfirm(`Let Aggie ${req.action} "${label(el || document.activeElement) || "this element"}"?`))) {
        return { result: `user cancelled ${req.action}` };
      }
      switch (req.action) {
        case "click":
          el.click();
          return { result: `clicked [${req.index}]` };
        case "type":
          el.focus();
          if (el.isContentEditable) {
            el.textContent = req.text || "";
            el.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            setNativeValue(el, req.text || "");
          }
          return { result: `typed into [${req.index}]` };
        case "clear":
          if (el.isContentEditable) el.textContent = "";
          else setNativeValue(el, "");
          return { result: `cleared [${req.index}]` };
        case "select": {
          const opt = [...el.options].find((o) => o.text.trim() === (req.text || "").trim() || o.value === req.text);
          if (opt) {
            el.value = opt.value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { result: `selected "${req.text}"` };
          }
          return { result: `no option "${req.text}"` };
        }
        case "scroll":
          window.scrollBy({ top: (req.direction === "up" ? -1 : 1) * innerHeight * 0.8, behavior: "instant" });
          return { result: `scrolled ${req.direction || "down"}` };
        case "key": {
          const target = document.activeElement || document.body;
          const key = req.text || "Enter";
          for (const t of ["keydown", "keypress", "keyup"]) {
            target.dispatchEvent(new KeyboardEvent(t, { key, bubbles: true }));
          }
          return { result: `pressed ${key}` };
        }
        default:
          return { result: `unknown action ${req.action}` };
      }
    } catch (e) {
      return { result: `error: ${e.message}` };
    }
  }

  // ---- Messaging --------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg.cmd) {
      case "ping":
        reply({ ok: true });
        return true;
      case "toggle":
        if (open) closeTextSurface();
        else openTextSurface({ fresh: false });
        reply({ ok: true });
        return true;
      case "open":
        openTextSurface({ fresh: false });
        reply({ ok: true });
        return true;
      case "toggleVoice":
        if (!root) build();
        toggleVoiceSession();
        reply({ ok: true });
        return true;
      case "snapshot":
        reply(snapshot());
        return true;
      case "act":
        act(msg).then(reply);
        return true;
      case "confirm":
        askInlineConfirm(msg.text || "Allow Aggie to continue?").then((ok) => reply({ ok }));
        return true;
      case "progress":
        updateCue(msg.cueId, msg.text, "running");
        return false;
      case "done":
        updateCue(msg.cueId, msg.summary, "done");
        setSurfacePhase("editing");
        reactLauncher("done"); // hop + ring + happy chime
        // Replies live in the cue/result surface. The composer stays free for
        // the next command instead of becoming a chat transcript.
        if (agentState === "thinking") setAgentState("idle");
        return false;
      case "error":
        showCueError(msg.cueId, msg.text); // shake + ring + falling chime when visible
        setSurfacePhase("editing");
        if (agentState === "thinking" || agentState === "speaking") setAgentState("idle");
        return false;
      case "agentRevoked":
        handleAgentRevoked(msg);
        return false;
      case "browserAgentOwnerChanged":
        handleBrowserAgentOwnerChanged(msg);
        reply({ ok: true, ownerState: browserAgentOwnerState });
        return true;
      case "ambient":
        setAmbientState(msg.state);
        reply({ ok: true, state: ambientState });
        return true;
      case "voiceSessionEvent":
        {
          const state = liveVoiceBySessionId.get(msg.voiceSessionId);
          if (state) handleLiveVoiceMessage(state, msg);
        }
        return false;
    }
  });

  build();
  startDevReloadWatcher().catch(() => {});
})();
