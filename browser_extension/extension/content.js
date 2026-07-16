// agee - content script. Owns the on-page surface, perceives the page, executes actions.

(() => {
  const AGGIE_ROOT_ID = "agee-root";
  const CONTENT_RUNTIME_VERSION = String(chrome.runtime.getManifest().version || "unknown");
  const existingAggies = () => Array.from(document.querySelectorAll(`#${AGGIE_ROOT_ID}`));
  const pruneDuplicateAggies = () => {
    const nodes = existingAggies();
    const keep = nodes.find((node) => node.querySelector("#agee-launcher")) || nodes[0] || null;
    for (const node of nodes) {
      if (node !== keep) node.remove();
    }
  };

  if (window.top !== window) return;
  if (window.__ageeLoaded === CONTENT_RUNTIME_VERSION) {
    pruneDuplicateAggies();
    return;
  }
  window.__ageeLoaded = CONTENT_RUNTIME_VERSION;
  existingAggies().forEach((node) => node.remove());

  // ---- Overlay UI -------------------------------------------------------
  let root,
    launcher,
    panel,
    input,
    agentModeSelect,
    voiceButton,
    recordButton,
    stopButton,
    log,
    langChip,
    uiSpecSurfaceEl,
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
    holdToTalkTimer = null,
    holdToTalkActive = false,
    holdToTalkPointerId = null,
    launcherSecondTapAction = null,
    voiceHotkeyState = null,
    voiceHotkeyHoldTimer = null,
    lastLocalTextHotkeyAt = 0,
    lastLocalVoiceHotkeyAt = 0,
    lastExternalVoiceCommandAt = 0,
    // The A.G. mark stays where the user drops it and reacts visually to state.
    // audioCtx is created lazily when explicit voice playback needs it.
    audioCtx = null;
  // Custom tooltip chip + viewport-resize batching for the overlay.
  let tipEl = null,
    tipTimer = null,
    tipTarget = null,
    resizeRaf = null;
  const assistantPlaybackSources = new Set();
  const liveVoiceStates = new Set();
  const liveVoiceBySessionId = new Map();
  const DOUBLE_CLICK_HOLD_MS = 260;
  const LAUNCHER_DOUBLE_CLICK_MS = 280;
  const LAUNCHER_TAP_MAX_MS = 500;
  const LAUNCHER_DOUBLE_CLICK_SLOP = 28;
  const LAUNCHER_DRAG_SLOP = 4;
  // Canonical mark contract: single click toggles current-thread capture,
  // double click starts/stops fresh-thread capture, and triple click opens chat.
  const VOICE_FIRST_HOLD_MS = 260;
  let voiceFirstHoldTimer = null;
  let voiceFirstTapChain = null;
  let voiceFirstHoldStartedTurn = false;
  let voiceFirstCaptureOrigin = null;
  // Mascot scale: one root scalar (font-size px on #agee-launcher) drives the
  // hit circle, the lion and every animation distance. Scroll on the lion
  // adjusts it; the value persists like the launcher position does.
  const MASCOT_FONT_DEFAULT = 26;
  const MASCOT_FONT_MIN = 12;
  const MASCOT_FONT_MAX = 72;
  const MASCOT_SCALE_SAVE_DEBOUNCE_MS = 350;
  let mascotFontPx = MASCOT_FONT_DEFAULT;
  let mascotScaleSaveTimer = null;
  const COMMAND_ECHO_DEDUPE_MS = 450;
  let browserAgentOwner = null;
  let browserAgentOwnerState = "unknown";
  let assistantSpeechOverlap = false;
  let uiChimesEnabled = false;
  const DEV_RELOAD_DEFAULT_SERVER = "http://localhost:7777";
  const DEV_RELOAD_POLL_MS = 900;
  const SELF_EXTENSION_RUNTIME_CACHE_KEY = "ageeSelfExtensionRuntime";
  const UI_SPEC_CACHE_KEY = "ageeUiSpec";
  const ACTIVE_COMPANION_PET_CACHE_KEY = "ageeActiveCompanionPetCache";
  const BROWSER_AGENT_ROLE_KEY = "ageeBrowserAgentRole";
  const BROWSER_AGENT_ROLES = new Set(["delegate", "help", "collaborate", "explain"]);
  const PROFILE_CACHE_KEY = "ageeProfileCache";
  // Language chip: what A.G. currently hears (STT) and speaks (reply), read
  // from the cached gateway profile and kept live across a running turn.
  let ageeProfileCacheValue = null;
  let lastReplyLanguageCode = "";
  let devReloadTimer = null;
  let devReloadInFlight = false;
  let devReloadVersion = null;
  const voicePolicy = window.AgeeContentVoicePolicyRuntime;
  const companionPolicy = window.AgeeContentCompanionPolicyRuntime;
  const {
    base64ToBuffer,
    canCallExtensionApi,
    isExtensionContextInvalidated,
    markExtensionContextInvalidated,
    safeRuntimeSendMessage,
    safeStorageLocalGet,
    safeStorageLocalSet,
  } = window.AgeeContentExtensionApiRuntime.createContentExtensionApiRuntime({
    getChrome: () => (typeof chrome === "undefined" ? undefined : chrome),
    decodeBase64: (value) => atob(value),
    ByteArray: Uint8Array,
  });
  const {
    armNewThread,
    consumeContextControls,
    maybeHandleContextSlashCommand,
  } = window.AgeeContentContextControlRuntime.createContentContextControlRuntime({
    onModeCue: showContextModeCue,
  });
  const {
    isVideoNoteActive,
    stopVideoNoteMode,
    toggleRecordMode,
    toggleVideoNoteMode,
  } = window.AgeeContentNoteControllerRuntime.createContentNoteControllerRuntime({
    sendMessage: safeRuntimeSendMessage,
    isExtensionContextInvalidated,
    openSurface: () => openTextSurface({ fresh: false }),
    isVoiceActive: () => Boolean(liveVoice || listening),
    setCaptureState: setNoteCaptureState,
    newCueId,
    materializeCue,
    updateCue,
    reactLauncher,
    now: () => Date.now(),
  });
  const {
    applyUiSpec,
    loadUiSpec,
  } = window.AgeeContentUiControllerRuntime.createContentUiControllerRuntime({
    document,
    uiSpecRuntime: globalThis.AgeeUiSpecRuntime,
    storageGet: safeStorageLocalGet,
    sendMessage: safeRuntimeSendMessage,
    getRoot: () => root,
    getSurface: () => uiSpecSurfaceEl,
    getInput: () => input,
    anchorPanel: positionPanel,
    openSurface: () => openTextSurface({ fresh: false }),
    setInputText,
    primeAudio,
    toggleVoice,
    describePage,
    submitInstruction,
    cacheKey: UI_SPEC_CACHE_KEY,
  });
  const COMPANION_PET_COLORS = {
    graphite: ["#555a62", "#262a30"],
    green: ["#208553", "#0f5534"],
    blue: ["#2f67d8", "#173778"],
    violet: ["#7651c7", "#452284"],
    red: ["#d84a39", "#84281f"],
    amber: ["#c57a1b", "#77450e"],
    teal: ["#0e7d85", "#06484e"],
    mono: ["#f6f3ea", "#17191d"],
  };
  const AVATAR_MOTION_CLASSES = [
    "agee-avatar-motion-still",
    "agee-avatar-motion-pulse",
    "agee-avatar-motion-hop",
    "agee-avatar-motion-orbit",
    "agee-avatar-motion-float",
    "agee-avatar-motion-shake",
    "agee-avatar-motion-glow",
  ];
  const AVATAR_TRIGGER_CLASSES = [
    "agee-avatar-trigger-idle",
    "agee-avatar-trigger-editing",
    "agee-avatar-trigger-listening",
    "agee-avatar-trigger-thinking",
    "agee-avatar-trigger-speaking",
    "agee-avatar-trigger-done",
    "agee-avatar-trigger-error",
    "agee-avatar-trigger-attention",
    "agee-avatar-trigger-busy",
  ];
  let avatarBehaviorRuntime = null;
  let activeCompanionPet = null;

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

  function showContextModeCue(label, statusText) {
    const cueId = newCueId();
    openTextSurface({ fresh: false });
    createCue(cueId, label, { presentation: "card" });
    updateCue(cueId, statusText, "done");
  }
  function build() {
    root = document.createElement("div");
    root.id = "agee-root";
    root.dataset.ageeOwner = browserAgentOwnerState;
    root.innerHTML = `
      <button id="agee-launcher" type="button" data-agee-tip="Click to type, drag to move, scroll to resize, hold to talk" aria-label="A.G.">
        <span class="agee-ring" aria-hidden="true"></span>
        <span class="agee-shadow" aria-hidden="true"></span>
        <img class="agee-bird" src="${chrome.runtime.getURL("moa-mark.png")}" alt="" draggable="false" />
        <span class="agee-pet-mark" aria-hidden="true">
          <span class="agee-pet-shadow"></span>
          <img class="agee-pet-image" alt="" draggable="false" />
          <span class="agee-pet-core">
            <span class="agee-pet-ear agee-pet-ear-left"></span>
            <span class="agee-pet-ear agee-pet-ear-right"></span>
            <span class="agee-pet-arm agee-pet-arm-left"></span>
            <span class="agee-pet-arm agee-pet-arm-right"></span>
            <span class="agee-pet-body"></span>
            <span class="agee-pet-face"><i></i><i></i><b></b></span>
            <span class="agee-pet-foot agee-pet-foot-left"></span>
            <span class="agee-pet-foot agee-pet-foot-right"></span>
          </span>
        </span>
      </button>
      <div id="agee-panel" role="dialog" aria-label="A.G. command">
        <div id="agee-voice-state" aria-hidden="true">
          <span id="agee-orb"></span>
          <span id="agee-transcript" aria-live="polite"></span>
        </div>
        <div id="agee-ui-surface" aria-live="polite"></div>
        <div id="agee-lang-chip" class="agee-lang-chip" hidden aria-live="polite"></div>
        <div id="agee-log" aria-hidden="true"></div>
        <div id="agee-bar">
          <span id="agee-dot"></span>
          <textarea id="agee-input" rows="1" placeholder="Ask A.G." autocomplete="off" spellcheck="true"></textarea>
          <select id="agee-mode-select" data-agent-mode-control aria-label="Browser agent role">
            <option value="delegate" selected>Delegate</option>
            <option value="help">Help</option>
            <option value="collaborate">Collaborate</option>
            <option value="explain">Explain</option>
          </select>
          <button id="agee-voice" type="button" data-agee-tip="Speak your request" aria-label="Start voice"></button>
          <button id="agee-record" type="button" data-agee-tip="Capture an audio note (⇧click: video note)" aria-label="Record note"></button>
          <button id="agee-stop" type="button" data-agee-tip="Halt the running task" aria-label="Stop current task">Stop</button>
        </div>
      </div>
      <div id="agee-tip" role="tooltip" aria-hidden="true"></div>`;
    document.documentElement.appendChild(root);
    launcher = root.querySelector("#agee-launcher");
    panel = root.querySelector("#agee-panel");
    input = root.querySelector("#agee-input");
    agentModeSelect = root.querySelector("#agee-mode-select");
    voiceButton = root.querySelector("#agee-voice");
    recordButton = root.querySelector("#agee-record");
    stopButton = root.querySelector("#agee-stop");
    uiSpecSurfaceEl = root.querySelector("#agee-ui-surface");
    log = root.querySelector("#agee-log");
    langChip = root.querySelector("#agee-lang-chip");
    voiceState = root.querySelector("#agee-voice-state");
    transcriptEl = root.querySelector("#agee-transcript");
    tipEl = root.querySelector("#agee-tip");

    setupOverlayTooltips();
    setupCueLogInteractions();
    restoreLauncherPosition();
    restoreMascotScale();
    restoreUiChimePreference();
    restoreBrowserAgentRole();
    applyGestureModeHints();
    loadAvatarBehaviorRuntime();
    loadUiSpec();
    loadActiveCompanionPet();
    loadLanguageChip();
    // Single click toggles current-thread capture, double-click starts/stops a
    // fresh-thread capture, triple-click opens chat, and a still hold is PTT.
    launcher.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    launcher.addEventListener("pointerdown", startLauncherDrag);
    launcher.addEventListener("wheel", handleLauncherWheel, { passive: false });
    window.addEventListener("resize", handleViewportResize);
    agentModeSelect.addEventListener("change", () => {
      chrome.storage.local.set({ [BROWSER_AGENT_ROLE_KEY]: selectedBrowserAgentRole() }).catch(() => {});
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
        e.preventDefault();
        e.stopPropagation();
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

    recordButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Shift+click records a video note (screen + narration); a plain click
      // keeps the audio note. A video recording in progress stops on any click.
      if (isVideoNoteActive() || e.shiftKey) {
        toggleVideoNoteMode();
        return;
      }
      toggleRecordMode();
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

  // ---- Custom tooltips --------------------------------------------------
  // A single dark chip replaces native title tooltips on the overlay controls.
  // 400 ms hover delay, instant hide, edge-aware so it never clips a viewport
  // edge. aria-labels stay on the controls for assistive tech; the chip reads
  // the live data-agee-tip text so state-driven labels stay in sync.
  function setupOverlayTooltips() {
    if (!tipEl) return;
    for (const target of [launcher, voiceButton, recordButton, stopButton]) {
      if (!target) continue;
      target.addEventListener("mouseenter", () => armTooltip(target));
      target.addEventListener("mouseleave", hideTooltip);
      target.addEventListener("focus", () => armTooltip(target));
      target.addEventListener("blur", hideTooltip);
      target.addEventListener("pointerdown", hideTooltip);
    }
  }

  function armTooltip(target) {
    hideTooltip();
    if (!target?.getAttribute("data-agee-tip")) return;
    tipTarget = target;
    tipTimer = setTimeout(() => {
      if (tipTarget === target) showTooltip(target);
    }, 400);
  }

  function showTooltip(target) {
    if (!tipEl) return;
    const text = target.getAttribute("data-agee-tip");
    if (!text) return;
    tipEl.textContent = text;
    tipEl.setAttribute("data-show", "");
    tipEl.setAttribute("aria-hidden", "false");
    positionTooltip(target);
  }

  function positionTooltip(target) {
    if (!tipEl) return;
    const r = target.getBoundingClientRect();
    const tw = tipEl.offsetWidth;
    const th = tipEl.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8; // not enough room above → flip below
    tipEl.style.left = `${Math.round(left)}px`;
    tipEl.style.top = `${Math.round(top)}px`;
  }

  function hideTooltip() {
    if (tipTimer) {
      clearTimeout(tipTimer);
      tipTimer = null;
    }
    tipTarget = null;
    if (!tipEl) return;
    tipEl.removeAttribute("data-show");
    tipEl.setAttribute("aria-hidden", "true");
  }

  // Update a control's tooltip text; if that control's chip is showing, refresh
  // it in place so a state change (start↔send, record↔stop) reads immediately.
  function setTooltip(target, text) {
    if (!target) return;
    target.setAttribute("data-agee-tip", text);
    if (tipTarget === target && tipEl?.hasAttribute("data-show")) {
      tipEl.textContent = text;
      positionTooltip(target);
    }
  }

  // Re-clamp the launcher into the viewport and re-anchor the panel on resize
  // and orientation change so neither can end up off-screen. Batched to a frame.
  function handleViewportResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      reclampLauncher();
      if (open) positionPanel();
    });
  }

  function reclampLauncher() {
    if (!launcher) return;
    const rect = launcher.getBoundingClientRect();
    placeLauncher(rect.left, rect.top, false);
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

  function restoreMascotScale() {
    safeStorageLocalGet({ ageeMascotScale: null }).then(({ ageeMascotScale }) => {
      if (!launcher || !Number.isFinite(ageeMascotScale)) return;
      applyMascotScale(ageeMascotScale, false);
    }).catch(() => {});
  }

  function applyMascotScale(px, persist) {
    if (!launcher) return;
    mascotFontPx = Math.max(MASCOT_FONT_MIN, Math.min(MASCOT_FONT_MAX, px));
    launcher.style.setProperty("--agee-mascot-font", `${mascotFontPx}px`);
    reclampLauncher(); // growing near an edge must not push the lion off-screen
    if (!persist) return;
    clearTimeout(mascotScaleSaveTimer);
    mascotScaleSaveTimer = setTimeout(() => {
      safeStorageLocalSet({ ageeMascotScale: mascotFontPx }).catch(() => {});
    }, MASCOT_SCALE_SAVE_DEBOUNCE_MS);
  }

  function handleLauncherWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    const step = e.deltaY < 0 ? 2 : -2;
    applyMascotScale(mascotFontPx + step, true);
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
    launcherSecondTapAction = null;
    beginVoiceFirstPress(e);
    try {
      launcher.setPointerCapture(e.pointerId);
    } catch {}
    launcher.addEventListener("pointermove", moveLauncherDrag);
    launcher.addEventListener("pointerup", stopLauncherDrag);
    launcher.addEventListener("pointercancel", stopLauncherDrag);
  }

  function moveLauncherDrag(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    if (holdToTalkActive && e.pointerId === holdToTalkPointerId) {
      // Voice-first escape hatch: a large move during push-to-talk turns the
      // gesture into a drag (hold-then-move muscle memory). Cancel only a
      // capture the hold itself started; a hold riding an existing talk-mode
      // session releases the hold and leaves the session listening.
      const ex = e.clientX - dragState.startX;
      const ey = e.clientY - dragState.startY;
      if (ex * ex + ey * ey <= LAUNCHER_DOUBLE_CLICK_SLOP * LAUNCHER_DOUBLE_CLICK_SLOP) return;
      holdToTalkActive = false;
      holdToTalkPointerId = null;
      if (voiceFirstHoldStartedTurn) stopLiveVoiceTurn("cancel");
      voiceFirstHoldStartedTurn = false;
      dragState.moved = true;
    }
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (Math.abs(dx) + Math.abs(dy) > LAUNCHER_DRAG_SLOP) {
      dragState.moved = true;
      clearVoiceFirstHoldTimer();
    }
    placeLauncher(dragState.left + dx, dragState.top + dy, false);
  }

  function stopLauncherDrag(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const wasHoldToTalk = holdToTalkActive && e.pointerId === holdToTalkPointerId;
    const moved = dragState.moved;
    const chainCount = dragState.chainCount || 0;
    const downMs = e.timeStamp - dragState.startTime;
    dragState = null;
    try {
      launcher.releasePointerCapture(e.pointerId);
    } catch {}
    launcher.removeEventListener("pointermove", moveLauncherDrag);
    launcher.removeEventListener("pointerup", stopLauncherDrag);
    launcher.removeEventListener("pointercancel", stopLauncherDrag);
    clearVoiceFirstHoldTimer();
    if (wasHoldToTalk) {
      finishLauncherPushToTalk();
      resetVoiceFirstTapChain();
      return;
    }
    if (moved) {
      const rect = launcher.getBoundingClientRect();
      placeLauncher(rect.left, rect.top, true);
      return;
    }
    if (e.type === "pointercancel" || downMs > LAUNCHER_TAP_MAX_MS) return;
    handleVoiceFirstTap(e, chainCount);
  }

  function beginManualVoiceGesture() {
    openTextSurface({ fresh: false });
    primeAudio();
    if (liveVoice && listening) {
      commitLiveVoiceTurn();
      return "committed";
    }
    if (liveVoice) {
      stopLiveVoiceTurn("cancel");
    }
    startLiveVoiceTurn({
      preserveAssistantPlayback: assistantSpeechOverlap === true,
      conversation: false,
      autoCommit: false,
    });
    return "started";
  }

  function finishLauncherPushToTalk() {
    holdToTalkActive = false;
    holdToTalkPointerId = null;
    launcherSecondTapAction = null;
    finishManualPushToTalk();
  }

  function finishManualPushToTalk() {
    if (liveVoice && listening) commitLiveVoiceTurn();
  }

  // ---- Voice-first gesture machine (flag-gated) --------------------------
  // Chain membership is decided at press-down (up-to-down window, same as the
  // legacy isLauncherSecondTap), so a pending single-tap resolution never
  // fires in the middle of a double- or triple-click.
  function beginVoiceFirstPress(e) {
    clearVoiceFirstHoldTimer();
    const chain = voiceFirstTapChain;
    const withinWindow =
      chain &&
      e.timeStamp - chain.lastTime >= 0 &&
      e.timeStamp - chain.lastTime <= LAUNCHER_DOUBLE_CLICK_MS;
    const dx = chain ? e.clientX - chain.x : 0;
    const dy = chain ? e.clientY - chain.y : 0;
    const withinSlop = chain && dx * dx + dy * dy <= LAUNCHER_DOUBLE_CLICK_SLOP * LAUNCHER_DOUBLE_CLICK_SLOP;
    if (withinWindow && withinSlop) {
      if (chain.timer) {
        clearTimeout(chain.timer);
        chain.timer = null;
      }
      if (dragState) dragState.chainCount = chain.count;
    } else {
      resetVoiceFirstTapChain();
    }
    const pointerId = e.pointerId;
    voiceFirstHoldTimer = setTimeout(() => {
      voiceFirstHoldTimer = null;
      if (!dragState || dragState.pointerId !== pointerId || dragState.moved || holdToTalkActive) return;
      // A still hold is push-to-talk: a manual turn, committed on release.
      // Holding while talk mode is already listening rides that session, so
      // the release commits the current conversation turn.
      resetVoiceFirstTapChain();
      holdToTalkActive = true;
      holdToTalkPointerId = pointerId;
      voiceFirstHoldStartedTurn = false;
      if (!(liveVoice && listening)) {
        if (liveVoiceStates.size > 0) stopAllLiveVoiceTurns("cancel");
        stopSpeaking();
        voiceFirstHoldStartedTurn = true;
        voiceFirstCaptureOrigin = "hold";
        startLiveVoiceTurn({
          preserveAssistantPlayback: assistantSpeechOverlap === true,
          conversation: false,
          autoCommit: false,
          openText: false,
        });
      }
    }, VOICE_FIRST_HOLD_MS);
  }

  function clearVoiceFirstHoldTimer() {
    if (voiceFirstHoldTimer) {
      clearTimeout(voiceFirstHoldTimer);
      voiceFirstHoldTimer = null;
    }
  }

  function resetVoiceFirstTapChain() {
    if (voiceFirstTapChain?.timer) clearTimeout(voiceFirstTapChain.timer);
    voiceFirstTapChain = null;
  }

  function handleVoiceFirstTap(e, chainCount) {
    const count = chainCount + 1;
    resetVoiceFirstTapChain();
    const chain = {
      count,
      lastTime: e.timeStamp,
      x: e.clientX,
      y: e.clientY,
      timer: null,
    };
    voiceFirstTapChain = chain;
    // Resolve after the multi-click window so a pending single stop never sends
    // before a second or third click has a chance to supersede it.
    armVoiceFirstChainReset(() => resolveVoiceFirstTapChain(chain));
  }

  function armVoiceFirstChainReset(onExpire) {
    const chain = voiceFirstTapChain;
    if (!chain) return;
    chain.timer = setTimeout(() => {
      chain.timer = null;
      if (voiceFirstTapChain === chain) voiceFirstTapChain = null;
      if (typeof onExpire === "function") onExpire();
    }, LAUNCHER_DOUBLE_CLICK_MS);
  }

  function resolveVoiceFirstTapChain(chain) {
    if (!chain) return;
    const transition = AgeeVoiceCaptureGesture.resolveVoiceFirstTransition({
      tapCount: chain.count,
      capturing: voiceFirstCaptureActive(),
      captureOrigin: voiceFirstCaptureOrigin,
    });
    if (transition === "start_current" || transition === "commit_current" || transition === "commit_new") {
      toggleVoiceFirstCapture("single");
      return;
    }
    if (transition === "start_new" || transition === "cancel_then_start_new") {
      toggleFreshThreadVoiceCapture();
      return;
    }
    if (transition === "open_chat" || transition === "open_chat_preserve_capture") {
      openTextSurface({ fresh: false });
    }
  }

  function voiceFirstCaptureActive() {
    return liveVoice != null && listening === true && liveVoice.committed !== true;
  }

  function startVoiceFirstCapture(origin, { freshThread = false } = {}) {
    primeAudio();
    if (origin === "double") {
      parkPriorVoiceForSeparateCapture();
    } else {
      if (liveVoiceStates.size > 0) stopAllLiveVoiceTurns("cancel");
      stopSpeaking();
    }
    if (freshThread) {
      armNewThread();
    }
    voiceFirstCaptureOrigin = origin;
    startLiveVoiceTurn({
      preserveAssistantPlayback: assistantSpeechOverlap === true,
      conversation: false,
      autoCommit: false,
      openText: false,
    });
    if (liveVoice) liveVoice.tapTalk = true;
    syncTalkModeUi();
    return "on";
  }

  function parkPriorVoiceForSeparateCapture() {
    for (const state of liveVoiceStates) {
      if (state.committed !== true) continue;
      state.assistantSpeechSuppressed = true;
      stopLivePlayback(state);
    }
    stopSpeaking();
  }

  function toggleVoiceFirstCapture(origin) {
    if (voiceFirstCaptureActive()) {
      voiceFirstCaptureOrigin = null;
      commitLiveVoiceTurn();
      syncTalkModeUi();
      return "off";
    }
    return startVoiceFirstCapture(origin);
  }

  function toggleFreshThreadVoiceCapture() {
    if (voiceFirstCaptureActive() && voiceFirstCaptureOrigin === "double") {
      voiceFirstCaptureOrigin = null;
      commitLiveVoiceTurn();
      syncTalkModeUi();
      return "off";
    }
    if (voiceFirstCaptureActive()) cancelActiveUncommittedVoiceCapture();
    return startVoiceFirstCapture("double", { freshThread: true });
  }

  function cancelActiveUncommittedVoiceCapture() {
    const state = liveVoice;
    if (!state || state.committed === true) return false;
    conversationActive = false;
    voiceFirstCaptureOrigin = null;
    stopLiveVoiceState(state, "cancel");
    return true;
  }

  function syncTalkModeUi() {
    if (root) root.classList.toggle("agee-talk", conversationActive === true);
  }

  function applyGestureModeHints() {
    if (root) root.classList.add("agee-voice-first");
    if (launcher) {
      launcher.dataset.ageeTip = "Click to start or stop; hold to talk; double-click for a new thread; triple-click for chat";
    }
    syncTalkModeUi();
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
    const margin = 8;
    const pw = panel.offsetWidth || Math.min(540, window.innerWidth - 24);
    let left = lr.left + lr.width / 2 - pw / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
    panel.style.left = `${left}px`;
    panel.style.right = "auto";
    // Clamp vertically too, accounting for the panel's full height (which grows
    // with the cue stack), so the surface never spills past the top or bottom.
    const ph = panel.offsetHeight || 54;
    const maxTop = Math.max(margin, window.innerHeight - ph - margin);
    if (lr.top > 140) {
      // Open above the mark, bottom pinned just above it, so results stack up.
      let bottom = window.innerHeight - lr.top + gap;
      const maxBottom = Math.max(margin, window.innerHeight - ph - margin);
      bottom = Math.max(margin, Math.min(bottom, maxBottom));
      panel.style.bottom = `${bottom}px`;
      panel.style.top = "auto";
    } else {
      let top = lr.bottom + gap;
      top = Math.max(margin, Math.min(top, maxTop));
      panel.style.top = `${top}px`;
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

  function toggleTextSurface() {
    if (open) closeTextSurface();
    else openTextSurface({ fresh: false });
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
    syncAvatarBehaviorTrigger();
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
    syncAvatarBehaviorTrigger();
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
      row.querySelector(".agee-confirm-text").textContent = text || "Allow A.G. to continue?";
      row.addEventListener("click", (event) => {
        const button = event.target.closest("[data-agee-confirm]");
        if (!button) return;
        const ok = button.getAttribute("data-agee-confirm") === "yes";
        pendingConfirm = null;
        row.remove();
        root?.classList.remove("agee-confirming");
        syncAvatarBehaviorTrigger();
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
    syncAvatarBehaviorTrigger();
  }

  function loadAvatarBehaviorRuntime() {
    safeStorageLocalGet({ [SELF_EXTENSION_RUNTIME_CACHE_KEY]: null })
      .then((stored) => {
        const cached = stored?.[SELF_EXTENSION_RUNTIME_CACHE_KEY];
        if (cached) applyAvatarBehaviorRuntime(cached.runtime || cached);
      })
      .catch(() => {});
  }

  function sanitizeActiveCompanionPet(payload) {
    return companionPolicy.sanitizeActiveCompanionPet(payload, chrome.runtime.id);
  }

  function loadActiveCompanionPet() {
    safeStorageLocalGet({ [ACTIVE_COMPANION_PET_CACHE_KEY]: null })
      .then((stored) => {
        const cached = stored?.[ACTIVE_COMPANION_PET_CACHE_KEY];
        if (cached) applyActiveCompanionPet(cached.active_companion || cached);
      })
      .catch(() => {});
  }

  // ---- Language chip -----------------------------------------------------
  // "Hears en·am · Speaks am": a short, always-legible readout of what A.G.
  // currently understands (STT) and replies in (TTS/text), so the active
  // language is never a guess. Understood-language data comes from the
  // cached gateway profile (input_languages / input_language_primary); the
  // spoken side prefers the live reply_language from the current turn's
  // turn_done and otherwise falls back to the profile's language_primary.
  // Pure formatter: profile is the {input_languages, input_language_primary,
  // language, language_primary} shape cached under ageeProfileCache;
  // replyOverride is the live reply language for the current turn (state.
  // replyLanguage), which wins over the profile's reply setting when present.
  // Returns "" (never "undefined"/"null") when there is nothing to show, so
  // the caller can hide the chip instead of rendering garbage.
  function formatLanguageChipText(profile, replyOverride) {
    return companionPolicy.formatLanguageChipText(profile, replyOverride);
  }

  function renderLanguageChip() {
    if (!langChip) return;
    const profile = ageeProfileCacheValue?.profile || ageeProfileCacheValue || null;
    const text = formatLanguageChipText(profile, lastReplyLanguageCode);
    if (!text) {
      langChip.hidden = true;
      langChip.textContent = "";
      return;
    }
    langChip.hidden = false;
    langChip.textContent = text;
  }

  function loadLanguageChip() {
    safeStorageLocalGet({ [PROFILE_CACHE_KEY]: null })
      .then((stored) => {
        ageeProfileCacheValue = stored?.[PROFILE_CACHE_KEY] || null;
        renderLanguageChip();
      })
      .catch(() => {});
  }

  function applyActiveCompanionPet(payload) {
    activeCompanionPet = sanitizeActiveCompanionPet(payload);
    if (!root || !launcher) return;
    const image = launcher.querySelector(".agee-pet-image");
    root.classList.toggle("agee-companion-pet-active", Boolean(activeCompanionPet));
    launcher.classList.toggle("agee-pet-active", Boolean(activeCompanionPet));
    delete root.dataset.ageePetId;
    delete root.dataset.ageePetPalette;
    delete root.dataset.ageePetMotion;
    delete root.dataset.ageePetImage;
    launcher.style.removeProperty("--agee-pet-color");
    launcher.style.removeProperty("--agee-pet-dark");
    launcher.style.removeProperty("--agee-pet-scale");
    launcher.setAttribute("aria-label", "A.G.");
    launcher.dataset.ageeTip = "Click to type, drag to move, scroll to resize, hold to talk";
    launcher.removeAttribute("title");
    if (image) image.removeAttribute("src");
    if (!activeCompanionPet) return;

    const colors = COMPANION_PET_COLORS[activeCompanionPet.palette] || COMPANION_PET_COLORS.blue;
    root.dataset.ageePetId = activeCompanionPet.id;
    root.dataset.ageePetPalette = activeCompanionPet.palette;
    root.dataset.ageePetMotion = activeCompanionPet.motion;
    root.dataset.ageePetImage = activeCompanionPet.imageSrc ? "image" : "css";
    launcher.style.setProperty("--agee-pet-color", colors[0]);
    launcher.style.setProperty("--agee-pet-dark", colors[1]);
    launcher.style.setProperty("--agee-pet-scale", String(activeCompanionPet.scale));
    const label = `${activeCompanionPet.name} companion`;
    const motionSummary = activeCompanionPet.motion.replace(/-/g, " ");
    launcher.setAttribute("aria-label", `A.G., ${label}`);
    launcher.setAttribute("title", `A.G. - ${label}`);
    launcher.dataset.ageeTip = `${label} - ${motionSummary}`;
    if (image && activeCompanionPet.imageSrc) image.src = activeCompanionPet.imageSrc;
  }

  function sanitizeAvatarBehaviorRuntime(runtime) {
    return companionPolicy.sanitizeAvatarBehaviorRuntime(runtime);
  }

  function applyAvatarBehaviorRuntime(runtime) {
    avatarBehaviorRuntime = sanitizeAvatarBehaviorRuntime(runtime);
    if (!root || !launcher) return;
    launcher.classList.remove(...AVATAR_MOTION_CLASSES, ...AVATAR_TRIGGER_CLASSES);
    delete root.dataset.ageeAvatarBehaviorId;
    delete root.dataset.ageeAvatarMotion;
    delete root.dataset.ageeAvatarTrigger;
    delete root.dataset.ageeAvatarIntensity;
    delete root.dataset.ageeAvatarDuration;
    root.dataset.ageeAvatarActive = "false";
    root.classList.remove("agee-avatar-runtime-enabled", "agee-avatar-runtime-active");
    if (!avatarBehaviorRuntime) return;

    const { id, motion, trigger, intensity, duration } = avatarBehaviorRuntime;
    root.classList.add("agee-avatar-runtime-enabled");
    root.dataset.ageeAvatarBehaviorId = id;
    root.dataset.ageeAvatarMotion = motion;
    root.dataset.ageeAvatarTrigger = trigger;
    root.dataset.ageeAvatarIntensity = intensity;
    root.dataset.ageeAvatarDuration = duration;
    launcher.classList.add(`agee-avatar-motion-${motion}`, `agee-avatar-trigger-${trigger}`);
    syncAvatarBehaviorTrigger();
  }

  function syncAvatarBehaviorTrigger() {
    if (!root || !avatarBehaviorRuntime) return;
    const trigger = avatarBehaviorRuntime.trigger;
    const active =
      (trigger === "idle" && agentState === "idle" && !anyActive()) ||
      (trigger === "editing" && surfacePhase === "editing") ||
      (trigger === "busy" && (anyActive() || agentState === "thinking")) ||
      (trigger === "listening" && agentState === "listening") ||
      (trigger === "thinking" && agentState === "thinking") ||
      (trigger === "speaking" && agentState === "speaking") ||
      (trigger === "done" && lastTerminal === "done" && !anyActive()) ||
      (trigger === "error" && lastTerminal === "error" && !anyActive()) ||
      (trigger === "attention" && root.classList.contains("agee-confirming"));
    root.dataset.ageeAvatarActive = active ? "true" : "false";
    root.classList.toggle("agee-avatar-runtime-active", active);
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
  const MAX_CUE_CARDS = 20;
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

  // A card is not auto-dismissed once it finishes — the surface is a short
  // reading log now, not a toast that vanishes while you're still reading it.
  // Cards persist until the user dismisses one explicitly (see
  // selectCascadeDismissIds below), and are only ever pruned oldest-first past
  // MAX_CUE_CARDS. Nothing schedules a timer to remove a finished card anymore;
  // dismissCue() below is invoked only by an explicit user action.

  // Pure selection helper for the dismiss-and-cascade gesture (✕ button or
  // horizontal swipe): given the ordered list of cue cards (oldest first, the
  // same order they stack in #agee-log) and the id whose control fired, return
  // the ids to remove — that card and every older card above it. In-flight
  // (active) cards are never included, so a cascade that reaches back into a
  // still-running turn simply skips it instead of tearing down live state.
  // Kept dependency-free (no DOM, no closures over module state) so it can be
  // unit tested directly — see scripts/test-cue-dismiss.mjs.
  function selectCascadeDismissIds(cards, clickedId) {
    const list = Array.isArray(cards) ? cards : [];
    const idx = list.findIndex((card) => card && card.id === clickedId);
    if (idx === -1) return [];
    if (list[idx].active) return []; // in-flight: not dismissable
    const ids = [];
    for (let i = 0; i <= idx; i += 1) {
      const card = list[i];
      if (card && !card.active) ids.push(card.id);
    }
    return ids;
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

  // Dismiss cardId and every older card above it (see selectCascadeDismissIds).
  // Shared by the ✕ button and the swipe gesture below.
  function cascadeDismissFromCard(clickedId) {
    if (!log || !clickedId) return;
    const cards = [...log.querySelectorAll(".agee-cue")].map((card) => ({
      id: card.dataset.cue,
      active: activeCues.has(card.dataset.cue),
    }));
    for (const id of selectCascadeDismissIds(cards, clickedId)) dismissCue(id);
  }

  // A single delegated click handler for every card's ✕ button, plus a
  // pointer-based horizontal swipe as an equivalent gesture. The swipe only
  // claims the gesture once movement is deliberately horizontal past a small
  // threshold, so an ordinary attempt to select the answer text (which tends
  // to be short, vertical, or below the threshold) is left alone.
  const CUE_SWIPE_ACTIVATE_PX = 12;
  const CUE_SWIPE_DISMISS_PX = 72;
  let cueSwipeState = null;

  function setupCueLogInteractions() {
    if (!log) return;
    log.addEventListener("click", (event) => {
      const btn = event.target.closest(".agee-cue-dismiss");
      if (!btn || btn.disabled) return;
      const card = btn.closest(".agee-cue");
      if (card) cascadeDismissFromCard(card.dataset.cue);
    });
    log.addEventListener("pointerdown", handleCueSwipeStart);
  }

  function handleCueSwipeStart(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.target.closest(".agee-cue-dismiss, .agee-tweak-review")) return;
    const card = event.target.closest(".agee-cue");
    if (!card) return;
    const cueId = card.dataset.cue;
    if (!cueId || activeCues.has(cueId)) return; // in-flight: no swipe-dismiss
    cueSwipeState = { cueId, card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
    card.addEventListener("pointermove", handleCueSwipeMove);
    card.addEventListener("pointerup", handleCueSwipeEnd);
    card.addEventListener("pointercancel", handleCueSwipeEnd);
  }

  function handleCueSwipeMove(event) {
    const state = cueSwipeState;
    if (!state || event.pointerId !== state.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.dragging) {
      // Require a deliberate, mostly-horizontal drag before claiming the
      // gesture over normal text selection.
      if (Math.abs(dx) < CUE_SWIPE_ACTIVATE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      state.dragging = true;
      state.card.classList.add("agee-cue-dragging");
      try { state.card.setPointerCapture(state.pointerId); } catch { /* not capturable */ }
    }
    event.preventDefault();
    state.card.style.transform = `translateX(${dx}px)`;
    state.card.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / 200));
  }

  function handleCueSwipeEnd(event) {
    const state = cueSwipeState;
    if (!state || event.pointerId !== state.pointerId) return;
    state.card.removeEventListener("pointermove", handleCueSwipeMove);
    state.card.removeEventListener("pointerup", handleCueSwipeEnd);
    state.card.removeEventListener("pointercancel", handleCueSwipeEnd);
    cueSwipeState = null;
    if (!state.dragging) return;
    const dx = event.clientX - state.startX;
    state.card.classList.remove("agee-cue-dragging");
    state.card.style.transform = "";
    state.card.style.opacity = "";
    if (Math.abs(dx) >= CUE_SWIPE_DISMISS_PX) cascadeDismissFromCard(state.cueId);
  }

  // ---- Tweak review (fast overlay) --------------------------------------
  // After the agent changes this page, offer a tiny "Changes on this page"
  // affordance on the done cue. It lists this origin's tweaks by name, each with a
  // remove control wired to tweak:remove (undo). Deep management stays in options;
  // this is only enough to see and undo what just changed, in overlay style.
  function attachTweakReview(cueId) {
    const entry = cues.get(cueId);
    const card = entry?.cardEl || log?.querySelector(`.agee-cue[data-cue="${cueId}"]`);
    if (!card) return;
    if (card.querySelector(".agee-tweak-review")) return; // already attached

    const review = document.createElement("div");
    review.className = "agee-tweak-review";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "agee-tweak-toggle";
    toggle.textContent = "Changes on this page";
    const list = document.createElement("div");
    list.className = "agee-tweak-list";
    list.hidden = true;
    review.appendChild(toggle);
    review.appendChild(list);
    card.appendChild(review);

    // Opening the panel holds the card open so it does not fade mid-review.
    toggle.addEventListener("click", () => {
      const opening = list.hidden;
      list.hidden = !opening;
      if (opening) {
        holdCueOpen(cueId);
        renderTweakList(list);
      }
    });
  }

  function attachSettingsResults(cueId, payload) {
    const entry = cues.get(cueId);
    const card = entry?.cardEl || log?.querySelector(`.agee-cue[data-cue="${cueId}"]`);
    if (!card) return;
    card.querySelector(".agee-settings-results")?.remove();
    const settings = Array.isArray(payload?.settings) ? payload.settings : [];
    const list = document.createElement("div");
    list.className = "agee-settings-results";
    list.setAttribute("role", "listbox");
    for (const setting of settings) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "agee-setting-row";
      row.dataset.settingId = setting.id;
      row.setAttribute("role", "option");
      const title = document.createElement("strong");
      title.textContent = setting.title || setting.id;
      const current = document.createElement("span");
      current.textContent = `Current: ${formatOverlaySettingValue(setting.current)}`;
      const description = document.createElement("small");
      description.textContent = setting.description || "Registered setting.";
      row.append(title, current, description);
      row.addEventListener("click", () => {
        row.classList.toggle("agee-setting-row-expanded");
        description.textContent = row.classList.contains("agee-setting-row-expanded")
          ? `${setting.description || "Registered setting."} Owner: ${setting.owner || "unknown"}. Takes effect: ${setting.takes_effect || "unspecified"}.`
          : setting.description || "Registered setting.";
      });
      list.appendChild(row);
      if (setting.deep_link?.target === "microphone_permission") {
        const action = document.createElement("button");
        action.type = "button";
        action.className = "agee-setting-action";
        action.textContent = setting.deep_link.label || "Open microphone setup";
        action.addEventListener("click", () => {
          action.disabled = true;
          safeRuntimeSendMessage({ cmd: "openOptions", target: setting.deep_link.target }).then((result) => {
            if (!result?.ok) action.disabled = false;
          }).catch(() => { action.disabled = false; });
        });
        list.appendChild(action);
      }
    }
    if (!settings.length) list.textContent = "No registered settings matched.";
    card.appendChild(list);
    holdCueOpen(cueId);
  }

  function formatOverlaySettingValue(value) {
    if (value === null || value === undefined || value === "") return "Not set";
    if (Array.isArray(value)) return value.join(", ") || "None";
    if (typeof value === "object") return "Configured";
    return String(value);
  }

  // Apply a page_tweak action that arrived over the live voice socket. content.js
  // and tweaks.js are separate content scripts in the same tab and cannot message
  // each other directly, so the record is routed through the background, which
  // forwards it to the tweaks module as tweak:applyRecord — the same apply core the
  // HTTP turn path uses. After apply, the live cue shows the done summary and the
  // "Changes on this page" review affordance, matching the typed path.
  function applyLiveVoicePageTweak(state, action) {
    const record = action && action.type === "page_tweak" ? action.record : null;
    if (!record || typeof record !== "object") return;
    const cueId = state.cueId;
    updateCue(cueId, "changing this page…", "running");
    safeRuntimeSendMessage({ cmd: "tweakApplyRecord", record }).then((res) => {
      if (!res && isExtensionContextInvalidated()) return;
      if (!res?.ok) {
        const message = res?.error || "That page change was not a bounded tweak I can apply.";
        state.assistantText = message;
        updateCue(cueId, message, "done");
        return;
      }
      const tweak = res.tweak || {};
      const summary = `Changed this page — ${tweak.name || record.name || "page tweak"} is saved for ${res.origin || "this site"}.`;
      state.assistantText = summary;
      ensureVoiceCueCard(state, state.transcript || "Voice", summary);
      updateCue(cueId, summary, "done");
      holdCueOpen(cueId);
      attachTweakReview(cueId);
    }).catch((error) => {
      const message = `Page tweak failed: ${String(error?.message || error)}`;
      state.assistantText = message;
      updateCue(cueId, message, "done");
    });
  }

  function holdCueOpen(cueId) {
    const entry = cues.get(cueId);
    if (entry?.dismissTimer) {
      clearTimeout(entry.dismissTimer);
      entry.dismissTimer = null;
    }
  }

  function renderTweakList(listEl) {
    listEl.textContent = "loading…";
    safeRuntimeSendMessage({ cmd: "tweakList" }).then((res) => {
      const tweaks = Array.isArray(res?.tweaks) ? res.tweaks : [];
      listEl.textContent = "";
      if (tweaks.length === 0) {
        const empty = document.createElement("div");
        empty.className = "agee-tweak-empty";
        empty.textContent = "No changes saved for this site.";
        listEl.appendChild(empty);
        return;
      }
      for (const tweak of tweaks) {
        const rowEl = document.createElement("div");
        rowEl.className = "agee-tweak-row";
        const nameEl = document.createElement("span");
        nameEl.className = "agee-tweak-name";
        nameEl.textContent = tweak.name || tweak.kind || "page change";
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "agee-tweak-remove";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", () => {
          removeBtn.disabled = true;
          safeRuntimeSendMessage({ cmd: "tweakRemove", id: tweak.id }).then((out) => {
            if (out?.ok) rowEl.remove();
            else removeBtn.disabled = false;
            if (!listEl.querySelector(".agee-tweak-row")) renderTweakList(listEl);
          });
        });
        rowEl.appendChild(nameEl);
        rowEl.appendChild(removeBtn);
        listEl.appendChild(rowEl);
      }
    });
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
    // Finished cards from earlier turns are left in place — the log persists
    // until the user dismisses a card (see selectCascadeDismissIds). A new
    // turn only ever appends.
    currentCueId = cueId;
    const card = document.createElement("div");
    card.className = "agee-cue agee-cue-running";
    card.dataset.cue = cueId;
    const you = document.createElement("div");
    you.className = "agee-row agee-you";
    you.textContent = String(label || entry?.label || "A.G.");
    // Assistant header: a glowing status dot plus the label, so state reads from
    // the header rather than a heavy left border.
    const head = document.createElement("div");
    head.className = "agee-cue-head";
    const headDot = document.createElement("span");
    headDot.className = "agee-cue-dot";
    const headName = document.createElement("span");
    headName.className = "agee-cue-name";
    headName.textContent = "Agee";
    head.appendChild(headDot);
    head.appendChild(headName);
    // Skeleton shimmer shown while waiting, replaced by the answer once it
    // starts streaming (the card gains agee-cue-streaming).
    const skeleton = document.createElement("div");
    skeleton.className = "agee-cue-skeleton";
    skeleton.appendChild(document.createElement("div")).className = "agee-skeleton-line";
    skeleton.appendChild(document.createElement("div")).className = "agee-skeleton-line";
    const status = document.createElement("div");
    status.className = "agee-cue-status";
    status.textContent = statusText || "";
    // Dismiss control: removes this card and every older one above it. Hidden
    // while the turn is running (see CSS) and re-enabled by updateCue() once
    // the card lands on done/error — an in-flight card is never dismissable.
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "agee-cue-dismiss";
    dismissBtn.setAttribute("aria-label", "Dismiss this reply and everything above it");
    dismissBtn.textContent = "×";
    dismissBtn.disabled = true;
    card.appendChild(you);
    card.appendChild(head);
    card.appendChild(skeleton);
    card.appendChild(status);
    card.appendChild(dismissBtn);
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
    if (typeof text === "string" && text) {
      entry.statusEl.textContent = text;
      // Real streamed content arrived: drop the skeleton and fade the text in.
      if (kind === "running" && entry.cardEl) entry.cardEl.classList.add("agee-cue-streaming");
    }
    if (kind === "done" || kind === "error") {
      entry.cardEl.className = `agee-cue agee-cue-${kind}`;
      activeCues.delete(cueId);
      lastTerminal = kind;
      // No auto-dismiss timer: the card stays until the user dismisses it.
      // Turning off "running" just reveals and enables its ✕ control.
      const dismissBtn = entry.cardEl.querySelector(".agee-cue-dismiss");
      if (dismissBtn) dismissBtn.disabled = false;
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
    // Universal terminal chokepoint for a turn: every done/error/recover/route/
    // revoke/stop path funnels through here. Clearing the response watchdog here
    // guarantees it can never fire after a turn has ended (no false timeouts).
    clearVoiceWatchdog(state);
    liveVoiceStates.delete(state);
    if (state.voiceSessionId) liveVoiceBySessionId.delete(state.voiceSessionId);
    if (liveVoice === state) liveVoice = null;
  }

  function isLiveVoiceStateActive(state) {
    return !!state && liveVoiceStates.has(state);
  }

  // ---- Post-commit response watchdog ------------------------------------
  // After a voice turn is committed the mark sits in "thinking" and relies on
  // the gateway to send transcript/assistant_text/assistant_audio_*/turn_progress
  // /turn_done or to close the socket. A live-but-silent stall would hang
  // "thinking" forever. Arm a per-turn inactivity timer at commit; every inbound
  // voice-session event for that turn pushes it out. On expiry, surface a visible
  // timeout and tear the stalled turn down the same way a gateway error does.
  const VOICE_TURN_WATCHDOG_MS = 30000;

  function armVoiceWatchdog(state) {
    if (!state) return;
    clearVoiceWatchdog(state);
    state.watchdogTimer = setTimeout(() => {
      state.watchdogTimer = null;
      handleVoiceWatchdogTimeout(state);
    }, VOICE_TURN_WATCHDOG_MS);
  }

  function resetVoiceWatchdog(state) {
    // Only re-arm a watchdog that is already running (i.e. the turn was committed).
    // Pre-commit listening events must not start the timer.
    if (!state?.watchdogTimer) return;
    armVoiceWatchdog(state);
  }

  function clearVoiceWatchdog(state) {
    if (!state?.watchdogTimer) return;
    clearTimeout(state.watchdogTimer);
    state.watchdogTimer = null;
  }

  function handleVoiceWatchdogTimeout(state) {
    if (!isLiveVoiceStateActive(state)) return;
    // The gateway went silent after commit — no transcript, assistant text,
    // audio, turn_progress, or turn_done for the whole window. finishLiveVoiceError
    // shows the message in the result stack, closes the stalled session, settles
    // the mark to idle, and ends conversation mode so the mic does not silently
    // re-arm on a dead turn. It routes through untrackLiveVoiceState, which has
    // already nulled this timer, so there is no double fire.
    finishLiveVoiceError(state, "Voice turn timed out — try again");
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
    syncAvatarBehaviorTrigger();
  }

  // Fire a cue. Never blocks on a prior cue — that is the whole point: the user
  // keeps talking, each utterance becomes its own concurrent lane.
  function submitInstruction(instruction, displayText = instruction) {
    if (!instruction) return;
    // Client thread controls ("/new", "/incognito") are handled locally: they set
    // the mode, show it in the result stack, and never run a gateway turn.
    if (maybeHandleContextSlashCommand(instruction)) {
      setSurfacePhase("editing");
      input.focus();
      return;
    }
    // Fast local stop path for typed input: a whole-utterance "stop / shut up /
    // be quiet" halts playback and live turns immediately and silently. It never
    // sends the instruction to the gateway and never produces an assistant reply;
    // the only feedback is a minimal cue and the launcher returning to idle.
    if (isStopCommand(instruction)) {
      window.__ageeLastStopHalt = { source: "typed", at: Date.now() };
      const cueId = newCueId();
      openTextSurface({ fresh: false });
      createCue(cueId, displayText, { presentation: "card" });
      stopAllLiveVoiceTurns("cancel");
      stopSpeaking();
      updateCue(cueId, "", "done");
      setSurfacePhase("editing");
      input.focus();
      return;
    }
    const role = selectedBrowserAgentRole();
    if (role === "delegate") {
      const host = location.hostname || "this page";
      askInlineConfirm(
        `Delegate this task on ${host} for up to 20 steps? A.G. may click, type, select, scroll, press keys, wait, and capture page evidence. Navigation or sensitive or out-of-scope work stops for approval.`,
      ).then((confirmed) => {
        if (confirmed) dispatchInstruction(instruction, displayText, role, true);
      });
      return;
    }
    dispatchInstruction(instruction, displayText, role, false);
  }

  function dispatchInstruction(instruction, displayText, role, delegationConfirmed) {
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
    const context = consumeContextControls();
    safeRuntimeSendMessage({
      cmd: "run",
      instruction,
      cueId,
      agentRole: role,
      delegationConfirmed,
      contextAction: context.action,
      threadLabel: context.label,
    }).then(() => {
      if (isExtensionContextInvalidated()) removeCueCard(cueId);
    }).catch((error) => {
      showCueError(cueId, error?.message || error, { react: false });
    });
  }

  function selectedBrowserAgentRole() {
    const role = String(agentModeSelect?.value || "delegate").trim().toLowerCase();
    return BROWSER_AGENT_ROLES.has(role) ? role : "delegate";
  }

  function restoreBrowserAgentRole() {
    chrome.storage.local.get({ [BROWSER_AGENT_ROLE_KEY]: "delegate" }).then((stored) => {
      if (!agentModeSelect) return;
      const role = String(stored[BROWSER_AGENT_ROLE_KEY] || "delegate").trim().toLowerCase();
      agentModeSelect.value = BROWSER_AGENT_ROLES.has(role) ? role : "delegate";
    }).catch(() => {});
  }

  function describePage() {
    const cueId = newCueId();
    openTextSurface({ fresh: false });
    createCue(cueId, "Describe this page", { presentation: "card" });
    safeRuntimeSendMessage({ cmd: "describe", cueId }).then(() => {
      if (isExtensionContextInvalidated()) removeCueCard(cueId);
    }).catch((error) => {
      showCueError(cueId, error?.message || error, { react: false });
    });
  }

  function setVoiceState(next) {
    listening = next;
    if (voiceButton) {
      voiceButton.classList.toggle("listening", listening);
      voiceButton.textContent = "";
      setTooltip(voiceButton, listening ? "Send what you said" : "Speak your request");
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
    // Every stop/error/teardown path lands here, so the talk-mode ring can
    // never outlive conversation mode.
    syncTalkModeUi();
    syncAvatarBehaviorTrigger();
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

  function normalizeAssistantAudioSegment(msg) {
    return voicePolicy.normalizeAssistantAudioSegment(msg);
  }

  function recordAssistantPlaybackSegment(state, source, audioBuffer, startAt, fallbackRate) {
    voicePolicy.recordAssistantPlaybackSegment(state, source, audioBuffer, startAt, fallbackRate);
  }

  function computePlaybackProgress(state) {
    return voicePolicy.computePlaybackProgress(state, audioCtx?.currentTime);
  }

  function sendFinalPlaybackProgress(state) {
    if (!state?.voiceSessionId || state.playbackProgressSent) return;
    const progress = computePlaybackProgress(state);
    if (!progress) return;
    state.playbackProgressSent = true;
    sendLiveVoiceControl(state, progress);
  }

  function mergeLiveVoiceTranscript(previous, incoming) {
    return voicePolicy.mergeLiveVoiceTranscript(previous, incoming);
  }

  async function startLiveVoiceTurn(options = {}) {
    const preserveAssistantPlayback = options.preserveAssistantPlayback === true || assistantSpeechOverlap === true;
    if (!preserveAssistantPlayback) {
      stopSpeaking();
    }
    if (options.openText !== false) openTextSurface({ fresh: false });
    conversationActive = true;
    if (options.conversation === false) conversationActive = false;
    const cueId = newCueId();
    createCue(cueId, "", { presentation: "icon" });
    setVoiceState(true);
    setAgentState("listening");
    setTranscript("");

    // Fix the thread for this streaming voice turn. The WS branch is set at
    // session start, so background switches to the resolved branch before minting
    // the ticket. Incognito is persistent (re-armed each turn); the new-thread
    // arm is one-shot and consumed here.
    const context = consumeContextControls();

    const state = {
      cueId,
      turnId: `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      voiceSessionId: null,
      sessionReady: false,
      committed: false,
      playbackTime: 0,
      playbackRate: 1,
      playbackSources: new Set(),
      framesReceived: 0,
      framesPlayed: 0,
      pendingAssistantAudioSegments: [],
      playedAssistantAudioSegments: [],
      playbackProgressSent: false,
      assistantText: "",
      assistantSpeechSuppressed: false,
      transcript: "",
      awaitingExplicitDisposition: options.autoCommit === false,
      pendingFinalTranscript: "",
      gatewayRouted: false,
      incognito: context.action === "incognito",
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
        contextAction: context.action,
        threadLabel: context.label,
      });
      if (isExtensionContextInvalidated()) {
        stopLiveVoiceState(state, "context invalidated");
        setVoiceState(false);
        if (agentState !== "idle") setAgentState("idle");
        return;
      }
      if (!session?.ok || !session.voiceSessionId) {
        const recovery = session?.failure_code === "microphone_permission_denied" &&
          session?.recovery?.target === "microphone_permission"
          ? session.recovery
          : null;
        finishLiveVoiceError(state, session?.error || "gateway did not open a voice session", recovery);
        return;
      }
      attachLiveVoiceSession(state, session.voiceSessionId);
      if (state.commitWhenReady) commitLiveVoiceTurn();
    } catch (error) {
      finishLiveVoiceError(state, String(error?.message || error));
    }
  }

  function handleLiveVoiceMessage(state, payload) {
    // Any inbound voice-session event (audio chunk or JSON event) proves the turn
    // is still alive, so push the post-commit watchdog out. No-op until the turn
    // is committed (armed) and after it has ended (timer cleared on untrack).
    resetVoiceWatchdog(state);
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
    if (msg.type === "turn_progress") {
      // Keepalive emitted by the gateway every ~5s between commit and turn_done.
      // Its only job here is to prove the turn is still being worked; the watchdog
      // reset at the top of this handler already consumed it. Tolerated and routed
      // so a live-but-slow turn is never mistaken for a stall. Stage is available
      // as msg.stage for any future progress UI.
      return;
    }
    if (msg.type === "page_tweak") {
      // The live model proposed a bounded page change on this browser turn. The
      // native-audio model goes silent after a tool call, so the applied change
      // plus this cue is the primary confirmation; do not wait for spoken audio.
      applyLiveVoicePageTweak(state, msg.action || (msg.record ? { type: "page_tweak", record: msg.record } : null));
      return;
    }
    if (msg.type === "revoked") {
      revokeLiveVoiceState(state, msg.reason || "revoked");
      return;
    }
    if (msg.type === "transcript_partial" || msg.type === "transcript_final") {
      const incomingText = String(msg.text || "").trim();
      if (!incomingText) return;
      const text = mergeLiveVoiceTranscript(state.transcript, incomingText);
      state.transcript = text;
      if (isCurrentTurn) setTranscript(text, msg.type === "transcript_partial");
      updateCueLabel(state.cueId, text);
      ensureVoiceCueCard(state, text, "");
      // Transcript-final policy runs immediately for ordinary auto-commit voice.
      // Gesture captures hold it inert until the user's stop/send disposition,
      // so recognized speech cannot become settings or page-control work early.
      if (msg.type === "transcript_final") {
        if (state.awaitingExplicitDisposition) {
          state.pendingFinalTranscript = text;
          return;
        }
        applyLiveVoiceFinalTranscriptPolicy(state, text, { isCurrentTurn });
      }
      return;
    }
    if (msg.type === "assistant_text") {
      const text = String(msg.text || "").trim();
      if (!text) return;
      state.assistantText = text;
      // The assistant is now replying: flip the mark to speaking as soon as text
      // starts rendering, not only when spoken audio starts. Covers text-first
      // and text-only replies (response_modality text) where assistant_audio_start
      // never arrives, so the mark shows "responding" instead of hanging on
      // "thinking". assistant_audio_start re-asserts speaking; the flip is idempotent.
      if (isCurrentTurn) setAgentState("speaking");
      ensureVoiceCueCard(state, state.transcript || "Voice", text);
      updateCue(state.cueId, text, "running");
      return;
    }
    if (msg.type === "assistant_audio_segment") {
      const segment = normalizeAssistantAudioSegment(msg);
      if (segment) state.pendingAssistantAudioSegments.push(segment);
      return;
    }
    if (msg.type === "assistant_audio_start") {
      if (isCurrentTurn) {
        setVoiceState(false);
        setAgentState("speaking");
      }
      const rate = Number(msg.playback_rate);
      state.playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
      state.playbackTime = Math.max(audioCtx?.currentTime || 0, state.playbackTime || 0) + 0.04;
      return;
    }
    if (msg.type === "assistant_audio_done") {
      return;
    }
    if (msg.type === "turn_done") {
      const status = String(msg.status || "completed").toLowerCase();
      // Carry the gateway's own turn metadata so the done handler can render
      // honestly and, when assistant_text never arrived, look the stored turn up
      // by its canonical id.
      state.turnStatus = status;
      state.ttsSpoke = msg.tts_spoke === true;
      if (msg.reply_language) {
        state.replyLanguage = String(msg.reply_language);
        // Live-update the "Speaks" side of the language chip from this turn,
        // overriding the profile's default reply language until it changes.
        lastReplyLanguageCode = state.replyLanguage;
        renderLanguageChip();
      }
      if (msg.turn_id) state.gatewayTurnId = String(msg.turn_id);
      if (status === "no_speech" && !state.assistantText) {
        if (state.tapTalk && !String(state.transcript || "").trim()) {
          // Quiet disarm: a tap-armed talk turn that captured no speech was a
          // barge-in or a stray tap, not a failed utterance. Fold it away
          // without a cue and stop the conversation re-arm loop.
          conversationActive = false;
          stopLiveVoiceState(state, "stop");
          removeCueCard(state.cueId);
          setVoiceState(false);
          if (agentState !== "idle") setAgentState("idle");
          return;
        }
        // Explicit failed-capture turn from the gateway: no transcript and no
        // assistant output. Say so instead of pretending the turn completed.
        state.assistantText = "Didn't catch that.";
      } else if (status === "error") {
        // A terminal error turn must not read as a success. Surface the error
        // text in the cue instead of the misleading "Done."/"Replied out loud."
        finishLiveVoiceError(state, msg.message || msg.error || "Voice turn failed.");
        return;
      }
      finishLiveVoiceDone(state);
      return;
    }
    if (msg.type === "error") {
      if (msg.recoverable === false || msg.code === "microphone_capture_failed") {
        finishLiveVoiceError(state, msg.message || "Live voice microphone capture failed.", msg.recovery);
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
    if (state.assistantSpeechSuppressed) return;
    primeAudio();
    if (!audioCtx) return;
    const pcm = new Int16Array(buffer);
    const audioBuffer = audioCtx.createBuffer(1, pcm.length, 16000);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    const rate = state.playbackRate || 1;
    source.playbackRate.value = rate;
    source.connect(audioCtx.destination);
    state.playbackSources.add(source);
    assistantPlaybackSources.add(source);
    // Each scheduled PCM frame is one reply-text segment on the gateway's
    // frame->text ledger. Track received vs. naturally-finished frames so an
    // interrupt can report how far speech actually got (see cancel_turn sites).
    state.framesReceived = (state.framesReceived || 0) + 1;
    let counted = false;
    source.onended = () => {
      state.playbackSources.delete(source);
      assistantPlaybackSources.delete(source);
      // onended fires for both natural completion and an explicit stop(). The
      // cancel paths capture framesPlayed BEFORE stopping, so this only ever
      // records segments that finished on their own.
      if (!counted) {
        counted = true;
        state.framesPlayed = (state.framesPlayed || 0) + 1;
      }
    };
    const startAt = Math.max(audioCtx.currentTime + 0.02, state.playbackTime || 0);
    recordAssistantPlaybackSegment(state, source, audioBuffer, startAt, rate);
    source.start(startAt);
    state.playbackTime = startAt + audioBuffer.duration / rate;
  }

  async function commitLiveVoiceTurn() {
    const state = liveVoice;
    if (!state || !isLiveVoiceStateActive(state)) return;
    state.awaitingExplicitDisposition = false;
    const pendingFinalTranscript = state.pendingFinalTranscript;
    state.pendingFinalTranscript = "";
    if (pendingFinalTranscript && applyLiveVoiceFinalTranscriptPolicy(state, pendingFinalTranscript, { isCurrentTurn: true })) {
      return;
    }
    state.committed = true;
    stopLiveCapture(state);
    setVoiceState(false);
    setAgentState("thinking");
    // The turn is now waiting on the gateway. Arm the inactivity watchdog; any
    // inbound voice-session event for this turn resets it (see handleLiveVoiceMessage).
    armVoiceWatchdog(state);
    setTranscript(state.transcript || "");
    ensureVoiceCueCard(state, state.transcript || "Voice", "processing...");
    updateCue(state.cueId, "", "running");
    if (state.voiceSessionId) {
      safeRuntimeSendMessage({
        cmd: "voiceSessionControl",
        voiceSessionId: state.voiceSessionId,
        message: { type: "commit_turn", turn_id: state.turnId },
      }).then((res) => {
        if (!res && isExtensionContextInvalidated()) return;
        if (!res?.ok) finishLiveVoiceError(state, res?.error || "Live voice connection was not open.");
      }).catch((error) => finishLiveVoiceError(state, String(error?.message || error)));
    } else {
      state.commitWhenReady = true;
    }
  }

  function applyLiveVoiceFinalTranscriptPolicy(state, text, { isCurrentTurn = liveVoice === state } = {}) {
    if (!state || !text) return false;
    if (isStopCommand(text)) {
      haltForStopCommand(state);
      return true;
    }
    if (isCurrentTurn && applySpeechOverlapPolicyFromTranscript(state, text)) {
      return true;
    }
    if (isCurrentTurn && shouldRouteLiveTranscriptThroughGateway(text)) {
      routeLiveTranscriptThroughGateway(state, text);
      return true;
    }
    return false;
  }

  function routeLiveTranscriptThroughGateway(state, transcript) {
    if (liveVoice !== state || !isLiveVoiceStateActive(state) || state.gatewayRouted) return;
    const pageContextTurn = isPageContextTranscript(transcript);
    state.gatewayRouted = true;
    state.committed = true;
    stopLiveCapture(state);
    // Capture fully-played segments before stopLivePlayback stop()s the sources.
    const playedSegments = state.framesPlayed || 0;
    sendFinalPlaybackProgress(state);
    stopLivePlayback(state);
    setVoiceState(false);
    setAgentState("thinking");
    setTranscript(transcript);
    updateCueLabel(state.cueId, transcript);
    materializeCue(state.cueId, transcript, pageContextTurn ? "collecting page context" : "updating settings...");
    sendLiveVoiceControl(state, liveCancelTurnMessage(state, playedSegments));
    closeLiveVoiceSession(state, pageContextTurn ? "page context routed to browser agent" : "profile control routed to gateway");
    untrackLiveVoiceState(state);
    safeRuntimeSendMessage({
      cmd: "run",
      instruction: transcript,
      cueId: state.cueId,
      agentRole: pageContextTurn ? selectedBrowserAgentRole() : undefined,
      contextAction: state.incognito ? "incognito" : "",
    }).then(() => {
      if (isExtensionContextInvalidated()) removeCueCard(state.cueId);
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

  // Inline mirror of extension/stop-intent.js. content.js is a classic
  // content-script IIFE and cannot import the module, so the whole-utterance
  // stop matcher is duplicated here; the verify harness pins the two copies
  // together. Keep STOP_PHRASES and TRAILING_FILLERS aligned with that module.
  const STOP_PHRASES = [
    "stop",
    "stop it",
    "stop talking",
    "stop speaking",
    "shut up",
    "be quiet",
    "quiet",
    "silence",
    "hush",
    "enough",
  ];
  const STOP_TRAILING_FILLERS = ["please", "now", "already", "ok", "okay", "agee", "a g"];

  function isStopCommand(text) {
    const lower = normalizeSpokenCommand(text);
    if (!lower) return false;
    let words = lower.split(" ").filter(Boolean);
    let changed = true;
    while (changed && words.length > 1) {
      changed = false;
      if (STOP_TRAILING_FILLERS.includes(words[words.length - 1])) {
        words = words.slice(0, -1);
        changed = true;
      }
    }
    return STOP_PHRASES.includes(words.join(" "));
  }

  // Halt everything the stop command should silence: assistant playback and
  // every live voice turn, with no spoken or written acknowledgment. The
  // matched transcript is dropped, not sent on as a turn. Records a window flag
  // for smoke inspection only; it is not user-facing.
  function haltForStopCommand(state) {
    window.__ageeLastStopHalt = { source: "voice", at: Date.now() };
    if (state) untrackLiveVoiceState(state);
    stopAllLiveVoiceTurns("cancel");
    stopSpeaking();
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
    // Capture fully-played segments before stopLivePlayback stop()s the sources.
    const playedSegments = state.framesPlayed || 0;
    sendFinalPlaybackProgress(state);
    stopLivePlayback(state);
    if (mode === "cancel") sendLiveVoiceControl(state, liveCancelTurnMessage(state, playedSegments));
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

  function liveCancelTurnMessage(state, playedSegments) {
    // Additive: gateway records where speech stopped from played_segments. When
    // the counter is absent (older state / never played), send cancel_turn as-is.
    const message = { type: "cancel_turn", turn_id: state.turnId };
    const played = Number.isFinite(playedSegments) ? playedSegments : state?.framesPlayed;
    if (Number.isFinite(played) && played >= 0) message.played_segments = played;
    return message;
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

  // Ask the background worker for the gateway's stored copy of this turn and
  // return the canonical assistant text. The content script never holds the
  // gateway token; background.js owns the authenticated fetch. Returns "" when
  // the gateway is older (no such route), unreachable, or the turn has no text.
  async function fetchCanonicalVoiceTurnText(state) {
    const turnId = state.gatewayTurnId || state.turnId;
    if (!turnId) return "";
    let res;
    try {
      res = await Promise.race([
        safeRuntimeSendMessage({ cmd: "voiceTurnFetch", turnId }),
        new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
    } catch {
      return "";
    }
    if (!res?.ok || !res.turn || typeof res.turn !== "object") return "";
    const turn = res.turn;
    return String(turn.display || turn.text || turn.speak || "").trim();
  }

  async function finishLiveVoiceDone(state) {
    if (!isLiveVoiceStateActive(state)) return;
    const wasCurrentTurn = liveVoice === state;
    liveVoiceRecoveries = 0;
    // The turn is over; release the mic now so the canonical-text lookup below
    // never holds capture open.
    stopLiveCapture(state);

    // Native-audio Live models reply with audio only (assistant_text stays
    // empty). When that happens, ask the gateway for the stored turn so the cue
    // shows the real reply instead of the misleading "Done."/"Replied out loud."
    // the user reads as the assistant's whole answer.
    let summary = state.assistantText;
    const replied =
      state.turnStatus === "completed" || Boolean(state.playbackTime) || state.ttsSpoke === true;
    if (!summary && replied) {
      summary = await fetchCanonicalVoiceTurnText(state);
    }
    if (!summary) {
      const spoke = Boolean(state.playbackTime) || state.ttsSpoke === true;
      summary = spoke ? "Replied out loud (no transcript available)." : "Done.";
    }
    // An incognito voice turn ran on an inc- branch the gateway never persists;
    // mark the visible reply so the user knows nothing was saved.
    if (state.incognito && summary && !summary.endsWith("(not saved)")) {
      summary = `${summary}\n\n(not saved)`;
    }

    if (!isLiveVoiceStateActive(state)) return;
    ensureVoiceCueCard(state, state.transcript || "Voice", summary);
    updateCue(state.cueId, summary, "done");
    reactLauncher("done");
    if (!wasCurrentTurn) {
      sendFinalPlaybackProgress(state);
      closeLiveVoiceSession(state, "background reply done");
      untrackLiveVoiceState(state);
      return;
    }
    setVoiceState(false);
    // Wait for the spoken reply to finish playing, then either listen again (so
    // the user just keeps talking) or fall back to idle if the conversation was
    // stopped. Re-arming only after playback ends keeps the reply out of the mic.
    const delayMs = Math.max(0, ((state.playbackTime || 0) - (audioCtx?.currentTime || 0)) * 1000);
    setTimeout(() => {
      if (isLiveVoiceStateActive(state)) {
        sendFinalPlaybackProgress(state);
        closeLiveVoiceSession(state, "playback done");
        untrackLiveVoiceState(state);
      }
      if (liveVoice) return;
      if (conversationActive) {
        startLiveVoiceTurn({ preserveAssistantPlayback: assistantSpeechOverlap === true });
        return;
      }
      if (agentState !== "idle") setAgentState("idle");
    }, delayMs + 120);
  }

  function attachMicrophoneRecovery(cueId, recovery) {
    if (recovery?.target !== "microphone_permission") return;
    const entry = cues.get(cueId);
    if (!entry?.statusEl || entry.recoveryButton) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agee-cue-recovery";
    button.textContent = recovery.action_label || "Take me to microphone setup";
    button.addEventListener("click", () => {
      button.disabled = true;
      safeRuntimeSendMessage({ cmd: "openOptions", target: recovery.target })
        .then((result) => {
          if (!result?.ok) button.disabled = false;
        })
        .catch(() => {
          button.disabled = false;
        });
    });
    entry.statusEl.appendChild(button);
    entry.recoveryButton = button;
  }

  function finishLiveVoiceError(state, message, recovery = null) {
    if (!isLiveVoiceStateActive(state)) return;
    const shown = showCueError(state.cueId, message);
    attachMicrophoneRecovery(state.cueId, recovery);
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

  function toggleManualVoiceSession() {
    beginManualVoiceGesture();
  }

  // Audio/video note capture state is owned by the extracted controller. The
  // content script only projects that state onto the shared record control.
  function setNoteCaptureState(kind, active) {
    if (root) root.classList.toggle("agee-recording", active);
    if (recordButton) {
      recordButton.classList.toggle("recording", active);
      const isVideo = kind === "video";
      setTooltip(recordButton, active
        ? (isVideo ? "Finish the video note" : "Finish the recording")
        : "Capture an audio note (⇧click: video note)");
      recordButton.setAttribute("aria-label", active
        ? (isVideo ? "Stop video note" : "Stop recording")
        : "Record note");
    }
  }

  function clearVoiceHotkeyHoldTimer() {
    if (!voiceHotkeyHoldTimer) return;
    clearTimeout(voiceHotkeyHoldTimer);
    voiceHotkeyHoldTimer = null;
  }

  function armVoiceHotkeyGesture() {
    const startedAt = Date.now();
    const action = beginManualVoiceGesture();
    voiceHotkeyState = { action, hold: false, startedAt };
    clearVoiceHotkeyHoldTimer();
    if (action !== "started") return;
    voiceHotkeyHoldTimer = setTimeout(() => {
      voiceHotkeyHoldTimer = null;
      if (!voiceHotkeyState || voiceHotkeyState.action !== "started") return;
      voiceHotkeyState.hold = true;
    }, DOUBLE_CLICK_HOLD_MS);
  }

  function beginVoiceHotkey(e) {
    if (e.repeat || voiceHotkeyState) return;
    if (lastExternalVoiceCommandAt && Date.now() - lastExternalVoiceCommandAt < COMMAND_ECHO_DEDUPE_MS) return;
    lastLocalVoiceHotkeyAt = Date.now();
    armVoiceHotkeyGesture();
  }

  function beginVoiceCommandHotkey() {
    lastExternalVoiceCommandAt = Date.now();
    if (voiceHotkeyState || isLocalVoiceHotkeyRecent()) return;
    armVoiceHotkeyGesture();
  }

  function finishVoiceHotkey() {
    if (!voiceHotkeyState) return;
    const state = voiceHotkeyState;
    voiceHotkeyState = null;
    clearVoiceHotkeyHoldTimer();
    const heldLongEnough = state.startedAt && Date.now() - state.startedAt >= DOUBLE_CLICK_HOLD_MS;
    if (state.action === "started" && (state.hold || heldLongEnough)) finishManualPushToTalk();
  }

  function cancelVoiceHotkey() {
    if (!voiceHotkeyState) return;
    const state = voiceHotkeyState;
    voiceHotkeyState = null;
    clearVoiceHotkeyHoldTimer();
    if (state.action === "started" && state.hold) finishManualPushToTalk();
  }

  function isLocalVoiceHotkeyRecent() {
    return lastLocalVoiceHotkeyAt > 0 && Date.now() - lastLocalVoiceHotkeyAt < COMMAND_ECHO_DEDUPE_MS;
  }

  function shouldRouteLiveTranscriptThroughGateway(text) {
    return voicePolicy.shouldRouteLiveTranscriptThroughGateway(text);
  }

  function isPageContextTranscript(text) {
    return voicePolicy.isPageContextTranscript(text);
  }

  function applySpeechOverlapPolicyFromTranscript(state, text) {
    const policy = parseAssistantSpeechOverlapIntent(text);
    if (!policy) return false;

    assistantSpeechOverlap = policy.enabled;
    state.gatewayRouted = true;
    state.committed = true;
    stopLiveCapture(state);
    sendFinalPlaybackProgress(state);
    sendLiveVoiceControl(state, liveCancelTurnMessage(state, state.framesPlayed || 0));
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
    return voicePolicy.parseAssistantSpeechOverlapIntent(text);
  }

  function isProfileControlTranscript(text) {
    return voicePolicy.isProfileControlTranscript(text);
  }

  function normalizeSpokenCommand(value) {
    return voicePolicy.normalizeSpokenCommand(value);
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
          if (changes[SELF_EXTENSION_RUNTIME_CACHE_KEY]) {
            const cached = changes[SELF_EXTENSION_RUNTIME_CACHE_KEY].newValue;
            applyAvatarBehaviorRuntime(cached?.runtime || cached);
          }
          if (changes[UI_SPEC_CACHE_KEY]) {
            const cached = changes[UI_SPEC_CACHE_KEY].newValue;
            applyUiSpec(cached?.payload || cached);
          }
          if (changes[ACTIVE_COMPANION_PET_CACHE_KEY]) {
            const cached = changes[ACTIVE_COMPANION_PET_CACHE_KEY].newValue;
            applyActiveCompanionPet(cached?.active_companion || cached);
          }
          if (changes[PROFILE_CACHE_KEY] || changes.ageeGatewayUrl || changes.ageeGatewayToken) {
            loadActiveCompanionPet();
          }
          if (changes[PROFILE_CACHE_KEY]) {
            ageeProfileCacheValue = changes[PROFILE_CACHE_KEY].newValue || null;
            renderLanguageChip();
          }
          if (changes[BROWSER_AGENT_ROLE_KEY]) {
            const role = String(changes[BROWSER_AGENT_ROLE_KEY].newValue || "delegate").toLowerCase();
            if (agentModeSelect) agentModeSelect.value = BROWSER_AGENT_ROLES.has(role) ? role : "delegate";
          }
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
  //   ⌘.  (or Ctrl+.)         → quick voice toggle; hold for push-to-talk
  //   ⌘,  (or Ctrl+,)         → open the text command field

  function isVoiceHotkey(e) {
    return (e.metaKey || e.ctrlKey) && (e.key === "." || e.code === "Period");
  }

  function isTextHotkey(e) {
    return (e.metaKey || e.ctrlKey) && (e.key === "," || (!e.shiftKey && e.code === "Comma"));
  }

  function isVoiceHotkeyRelease(e) {
    if (!voiceHotkeyState) return false;
    return e.key === "." || e.code === "Period" || e.key === "Meta" || e.key === "Control";
  }

  function commandEchoIsRecent(kind) {
    const last = kind === "voice" ? lastLocalVoiceHotkeyAt : lastLocalTextHotkeyAt;
    return last > 0 && Date.now() - last < COMMAND_ECHO_DEDUPE_MS;
  }
  window.addEventListener(
    "keydown",
    (e) => {
      // ⌘. → voice/speech.
      if (isVoiceHotkey(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (!root) build();
        beginVoiceHotkey(e);
        return;
      }
      // ⌘, → text command field.
      if (isTextHotkey(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (!root) build();
        lastLocalTextHotkeyAt = Date.now();
        openTextSurface({ fresh: false });
        return;
      }
    },
    true
  );

  window.addEventListener(
    "keyup",
    (e) => {
      if (!isVoiceHotkeyRelease(e)) return;
      e.preventDefault();
      e.stopPropagation();
      finishVoiceHotkey();
    },
    true
  );

  window.addEventListener("blur", () => {
    cancelVoiceHotkey();
  });

  // ---- Perception -------------------------------------------------------
  const pageObservation = window.AgeePageObservationRuntime.createPageObservationRuntime({
    window,
    document,
  });

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
    const el = pageObservation.elementAt(req.index);
    if (["click", "type", "clear", "select"].includes(req.action) && !el) {
      return { result: `no element at index ${req.index}` };
    }
    try {
      if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
      // Background automation drives an invisible tab the user cannot answer a
      // confirm in. Those actions already passed the background's own local
      // action validator (the trust boundary), so skip the inline confirm when
      // req.background is set. Foreground actions keep the inline confirm.
      if (!req.background && pageObservation.needsConfirmation(el, req) && !(await askInlineConfirm(`Let A.G. ${req.action} "${pageObservation.label(el || document.activeElement) || "this element"}"?`))) {
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
        if (!(msg.source === "command" && commandEchoIsRecent("text"))) {
          toggleTextSurface();
        }
        reply({ ok: true });
        return true;
      case "open":
        openTextSurface({ fresh: false });
        reply({ ok: true });
        return true;
      case "toggleVoice":
        if (!root) build();
        if (msg.source === "command") {
          beginVoiceCommandHotkey();
        } else {
          toggleManualVoiceSession();
        }
        reply({ ok: true });
        return true;
      case "snapshot":
        reply(pageObservation.snapshot());
        return true;
      case "act":
        act(msg).then(reply);
        return true;
      case "confirm":
        askInlineConfirm(msg.text || "Allow A.G. to continue?").then((ok) => reply({ ok }));
        return true;
      case "progress":
        updateCue(msg.cueId, msg.text, "running");
        return false;
      case "stop":
        // Silent halt requested by the background stop guard: cut playback and
        // every live turn, no chime, no reply. The done that follows closes the
        // cue with empty text.
        haltForStopCommand(null);
        return false;
      case "browserAgentProgress":
        updateCue(
          msg.cueId,
          msg.text,
          msg.state === "error" ? "error" : msg.state === "done" ? "done" : "running"
        );
        return false;
      case "done":
        updateCue(msg.cueId, msg.summary, "done");
        // A page_tweak apply carries pageTweak: the done cue gets a small
        // "Changes on this page" review affordance (list + undo).
        if (msg.pageTweak) attachTweakReview(msg.cueId);
        setSurfacePhase("editing");
        reactLauncher("done"); // hop + ring + happy chime
        // Replies live in the cue/result surface. The composer stays free for
        // the next command instead of becoming a chat transcript.
        if (agentState === "thinking") setAgentState("idle");
        return false;
      case "settingsResults":
        attachSettingsResults(msg.cueId, msg.payload || {});
        return false;
      case "error":
        showCueError(msg.cueId, msg.text); // shake + ring + falling chime when visible
        setSurfacePhase("editing");
        if (agentState === "thinking" || agentState === "speaking") setAgentState("idle");
        return false;
      case "videoNoteAutoStop":
        // Chrome's "Stop sharing" bar or the length cap ended the capture:
        // finish the note exactly like a stop press.
        if (isVideoNoteActive()) stopVideoNoteMode();
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
      case "livekitAgentState":
        // Flag-gated LiveKit voice prototype: map the LiveKit agent-state
        // participant attribute onto the existing mark states.
        if (!root) build();
        if (["idle", "listening", "thinking", "speaking"].includes(msg.state)) {
          setAgentState(msg.state);
        }
        return false;
      case "livekitNotice":
        // Visible notice for the LiveKit path (e.g. fallback to WS voice).
        if (!root) build();
        if (msg.cueId) {
          updateCue(msg.cueId, msg.text, "running");
        }
        return false;
    }
  });

  build();
  startDevReloadWatcher().catch(() => {});
})();
