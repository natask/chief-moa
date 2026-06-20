// agee - content script. Owns the on-page surface, perceives the page, executes actions.

(() => {
  if (window.__ageeLoaded) return;
  window.__ageeLoaded = true;

  // ---- Overlay UI -------------------------------------------------------
  let root,
    launcher,
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
    dragState = null,
    suppressLauncherClick = false,
    // The Moa mark floats, wanders the page when idle, reacts to state, and
    // rings when something lands. audioCtx is created lazily on first gesture.
    audioCtx = null,
    assistantPlaybackSources = new Set(),
    wanderTimer = null,
    wanderPauseUntil = 0,
    wanderHover = false;

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
  function build() {
    root = document.createElement("div");
    root.id = "agee-root";
    root.innerHTML = `
      <button id="agee-launcher" type="button" title="⌘K to type · ⌘. to talk" aria-label="Moa">
        <span class="agee-ring" aria-hidden="true"></span>
        <span class="agee-shadow" aria-hidden="true"></span>
        <img class="agee-bird" src="${chrome.runtime.getURL("moa-mark.png")}" alt="" draggable="false" />
      </button>
      <div id="agee-panel" role="dialog" aria-label="Moa command">
        <div id="agee-voice-state" aria-hidden="true">
          <span id="agee-orb"></span>
          <span id="agee-transcript" aria-live="polite"></span>
        </div>
        <div id="agee-bar">
          <img id="agee-panel-mark" src="${chrome.runtime.getURL("moa-mark.png")}" alt="" draggable="false" />
          <span id="agee-dot"></span>
          <textarea id="agee-input" rows="1" placeholder="Ask Moa" autocomplete="off" spellcheck="true"></textarea>
          <button id="agee-voice" type="button" title="Start voice">Voice</button>
          <button id="agee-stop" type="button" title="Stop current task">Stop</button>
        </div>
        <div id="agee-log" aria-hidden="true"></div>
      </div>`;
    document.documentElement.appendChild(root);
    launcher = root.querySelector("#agee-launcher");
    input = root.querySelector("#agee-input");
    voiceButton = root.querySelector("#agee-voice");
    stopButton = root.querySelector("#agee-stop");
    log = root.querySelector("#agee-log");
    voiceState = root.querySelector("#agee-voice-state");
    transcriptEl = root.querySelector("#agee-transcript");

    restoreLauncherPosition();
    launcher.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (suppressLauncherClick) {
        suppressLauncherClick = false;
        return;
      }
      openTextSurface({ fresh: false });
    });
    launcher.addEventListener("pointerdown", startLauncherDrag);

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey && input.value.trim()) {
        e.preventDefault();
        if (surfacePhase === "pending") return;
        if (surfacePhase === "result" || surfacePhase === "error") {
          input.select();
          return;
        }
        submitInstruction(input.value.trim());
      } else if (e.key === "Escape") {
        closeTextSurface();
      }
    });
    input.addEventListener("input", () => {
      resizeInput();
      if (surfacePhase !== "pending") setSurfacePhase("editing");
    });

    voiceButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleVoice();
    });

    stopButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ cmd: "cancel" });
      stopLiveVoiceTurn("cancel");
      stopSpeaking();
      addLog("agee", "stopping…");
    });

    // Hovering the mark pauses its wandering so it is easy to grab or click; a
    // pointerdown anywhere primes the audio context so the chime can play later
    // (browsers only allow sound after a user gesture).
    launcher.addEventListener("pointerenter", () => {
      wanderHover = true;
    });
    launcher.addEventListener("pointerleave", () => {
      wanderHover = false;
    });
    window.addEventListener("pointerdown", primeAudio, { once: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleWander();
    });
    scheduleWander();
  }

  function restoreLauncherPosition() {
    chrome.storage.local.get({ ageeLauncherPosition: null }, ({ ageeLauncherPosition }) => {
      if (!launcher || !ageeLauncherPosition) return;
      const { x, y } = ageeLauncherPosition;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      placeLauncher(x, y, false);
    });
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
    if (persist) chrome.storage.local.set({ ageeLauncherPosition: { x: nextX, y: nextY } });
  }

  function startLauncherDrag(e) {
    if (e.button !== 0) return;
    const rect = launcher.getBoundingClientRect();
    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    launcher.setPointerCapture(e.pointerId);
    launcher.addEventListener("pointermove", moveLauncherDrag);
    launcher.addEventListener("pointerup", stopLauncherDrag);
    launcher.addEventListener("pointercancel", stopLauncherDrag);
  }

  function moveLauncherDrag(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragState.moved = true;
    placeLauncher(dragState.left + dx, dragState.top + dy, false);
  }

  function stopLauncherDrag(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const moved = dragState.moved;
    dragState = null;
    launcher.releasePointerCapture(e.pointerId);
    launcher.removeEventListener("pointermove", moveLauncherDrag);
    launcher.removeEventListener("pointerup", stopLauncherDrag);
    launcher.removeEventListener("pointercancel", stopLauncherDrag);
    if (moved) {
      const rect = launcher.getBoundingClientRect();
      placeLauncher(rect.left, rect.top, true);
      suppressLauncherClick = true;
    }
  }

  function toggle(force) {
    const was = open;
    open = typeof force === "boolean" ? force : !open;
    if (!root) build();
    root.classList.toggle("agee-open", open);
    if (open) {
      if (!was) chime("wake"); // pleasant beep when it engages (⌘K / shortcut)
      setTimeout(() => input.focus(), 0);
    }
  }

  function openTextSurface({ fresh = false } = {}) {
    if (!root) build();
    toggle(true);
    if (fresh || surfacePhase === "idle" || surfacePhase === "result" || surfacePhase === "error") {
      setInputText("");
      setSurfacePhase("editing");
    }
    setTimeout(() => {
      input.focus();
      if (surfacePhase === "result" || surfacePhase === "error") input.select();
    }, 0);
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
    if (input) input.readOnly = next === "pending";
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

  function showInlineResult(text, kind, { reveal = open } = {}) {
    if (!input) return;
    const fallback = kind === "error" ? "Something went wrong." : "Done.";
    setInputText(String(text || fallback).trim() || fallback, { select: reveal });
    setSurfacePhase(kind === "error" ? "error" : "result");
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
      row.querySelector(".agee-confirm-text").textContent = text || "Allow agee to continue?";
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
    // with the panel closed. Busy also halts wandering — it stays put and thinks.
    if (launcher) launcher.classList.toggle("agee-busy", anyActive());
  }

  // ---- Cue cards --------------------------------------------------------
  // Each cue gets a card: the user's line plus a live status line that moves
  // from "thinking…" through progress to a final answer/error.
  function newCueId() {
    cueSeq += 1;
    return `c_${cueSeq}_${Date.now().toString(36)}`;
  }

  function resetVisibleTurn() {
    if (pendingConfirm) {
      pendingConfirm(false);
      pendingConfirm = null;
      root?.classList.remove("agee-confirming");
    }
    if (log) log.replaceChildren();
    cues.clear();
    activeCues.clear();
    lastTerminal = "";
    currentCueId = null;
    refreshStatus();
  }

  function createCue(cueId, label, { presentation = "text" } = {}) {
    if (!log) return;
    resetVisibleTurn();
    currentCueId = cueId;
    const card = document.createElement("div");
    card.className = "agee-cue agee-cue-running";
    card.dataset.cue = cueId;
    const you = document.createElement("div");
    you.className = "agee-row agee-you";
    you.textContent = label;
    const status = document.createElement("div");
    status.className = "agee-cue-status";
    status.textContent = "thinking…";
    card.appendChild(you);
    card.appendChild(status);
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    cues.set(cueId, { statusEl: status, cardEl: card, labelEl: you, presentation });
    activeCues.add(cueId);
    if (presentation === "text") {
      setInputText(label);
      setSurfacePhase("pending");
    }
    refreshStatus();
  }

  function updateCueLabel(cueId, text) {
    const value = String(text || "").trim();
    if (!value) return;
    const entry = cues.get(cueId);
    if (entry?.labelEl) entry.labelEl.textContent = value;
  }

  // Update a cue's status line. kind: "running" | "done" | "error".
  function updateCue(cueId, text, kind) {
    const entry = cues.get(cueId);
    // A message for an unknown cue (e.g. server-generated id) falls back to a row.
    // Tag the terminal kind so harnesses can distinguish final state from
    // interim progress in the hidden one-turn ledger.
    if (!entry) {
      if (cueId && currentCueId && cueId !== currentCueId) return;
      addLog(kind === "error" ? "error" : kind === "done" ? "done" : "agee", text);
      if (open && kind === "running") setSurfacePhase("pending");
      if (kind === "done" || kind === "error") {
        if (open) showInlineResult(text, kind);
        lastTerminal = kind;
        refreshStatus();
      }
      return;
    }
    if (typeof text === "string" && text) entry.statusEl.textContent = text;
    if (entry.presentation === "text" && kind === "running") setSurfacePhase("pending");
    if (kind === "done" || kind === "error") {
      entry.cardEl.className = `agee-cue agee-cue-${kind}`;
      activeCues.delete(cueId);
      lastTerminal = kind;
      if (entry.presentation === "text") showInlineResult(text, kind);
    }
    refreshStatus();
    if (log) log.scrollTop = log.scrollHeight;
  }

  function stopSpeaking() {
    stopAllAssistantPlayback();
    if (agentState === "speaking") setAgentState("idle");
  }

  // ---- The mark: sound, reactions, wandering ----------------------------
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
    // A reaction means something happened: hop in place, then resume roaming.
    wanderPauseUntil = Date.now() + 2600;
  }

  // ---- Wandering --------------------------------------------------------
  // When idle (overlay closed, nothing running, not just dragged or hovered),
  // the mark glides to a new spot every so often so it feels alive on the page.
  function scheduleWander() {
    clearTimeout(wanderTimer);
    wanderTimer = setTimeout(wanderStep, 5000 + Math.random() * 7000);
  }

  function wanderStep() {
    const blocked =
      !launcher || open || anyActive() || wanderHover || dragState || document.hidden ||
      Date.now() < wanderPauseUntil;
    if (!blocked) {
      const rect = launcher.getBoundingClientRect();
      const margin = 18;
      const x = margin + Math.random() * Math.max(0, window.innerWidth - rect.width - margin * 2);
      const y = margin + Math.random() * Math.max(0, window.innerHeight - rect.height - margin * 2);
      glideTo(x, y);
    }
    scheduleWander();
  }

  // Glide (not snap) to a target, facing the direction of travel. Wander moves
  // are not persisted — only a deliberate drag pins the mark (see stopLauncherDrag).
  function glideTo(x, y) {
    if (!launcher) return;
    const from = launcher.getBoundingClientRect().left;
    launcher.classList.add("agee-gliding");
    launcher.classList.toggle("agee-face-left", x < from);
    placeLauncher(x, y, false);
    setTimeout(() => launcher && launcher.classList.remove("agee-gliding"), 2400);
  }

  // Fire a cue. Never blocks on a prior cue — that is the whole point: the user
  // keeps talking, each utterance becomes its own concurrent lane.
  function submitInstruction(instruction, displayText = instruction) {
    if (!instruction) return;
    const cueId = newCueId();
    openTextSurface({ fresh: false });
    createCue(cueId, displayText, { presentation: "text" });
    // A voice-launched turn keeps the agent surface up and moves it to thinking;
    // a typed command leaves the voice surface untouched.
    if (agentState !== "idle") {
      setTranscript(displayText);
      setAgentState("thinking");
    }
    input.focus();
    chrome.runtime.sendMessage({ cmd: "run", instruction, cueId }).catch((error) => {
      updateCue(cueId, String(error?.message || error), "error");
    });
  }

  function describePage() {
    const cueId = newCueId();
    openTextSurface({ fresh: false });
    createCue(cueId, "Describe this page", { presentation: "text" });
    chrome.runtime.sendMessage({ cmd: "describe", cueId }).catch((error) => {
      updateCue(cueId, String(error?.message || error), "error");
    });
  }

  function setVoiceState(next) {
    listening = next;
    if (voiceButton) {
      voiceButton.classList.toggle("listening", listening);
      voiceButton.textContent = listening ? "Listening" : "Voice";
    }
  }

  // Drive the visible "agent is up" surface. Adds a class on the root so the
  // orb, transcript bar, and panel chrome reflect the live phase. The transcript
  // bar is only present while listening or just-submitted; it clears on idle.
  function setAgentState(next) {
    agentState = next;
    if (!root) return;
    for (const s of ["idle", "listening", "thinking", "speaking"]) {
      root.classList.toggle(`agee-state-${s}`, s === next);
    }
    const voicing = next !== "idle";
    root.classList.toggle("agee-voicing", voicing);
    if (voiceState) voiceState.setAttribute("aria-hidden", voicing ? "false" : "true");
    if (next === "idle") setTranscript("");
  }

  // Render the live transcript bar. `interim` softens words that are still being
  // finalized by the gateway/provider.
  function setTranscript(text, interim = false) {
    if (!transcriptEl) return;
    transcriptEl.textContent = text || "";
    transcriptEl.classList.toggle("agee-interim", !!interim && !!text);
  }

  async function startLiveVoiceTurn() {
    stopSpeaking();
    closeTextSurface();
    const cueId = newCueId();
    createCue(cueId, "Listening...", { presentation: "icon" });
    updateCue(cueId, "listening...", "running");
    setVoiceState(true);
    setAgentState("listening");
    setTranscript("Listening...", true);
    setInputText("");

    const state = {
      cueId,
      turnId: `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ws: null,
      stream: null,
      source: null,
      processor: null,
      sampleRate: 0,
      resample: { offset: 0 },
      sessionReady: false,
      committed: false,
      playbackTime: 0,
      playbackSources: new Set(),
      assistantText: "",
      transcript: "",
    };
    liveVoice = state;

    try {
      const ticket = await chrome.runtime.sendMessage({ cmd: "voiceSessionTicket" });
      if (!ticket?.ok || !ticket.ws_url) {
        throw new Error(ticket?.error || "gateway did not return a voice session ticket");
      }

      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      primeAudio();
      if (!audioCtx) throw new Error("Web Audio is not available in this browser.");
      state.sampleRate = audioCtx.sampleRate;

      state.ws = new WebSocket(ticket.ws_url);
      state.ws.binaryType = "arraybuffer";
      state.ws.onopen = () => {
        state.ws.send(JSON.stringify({
          type: "session_start",
          source: "agee-extension",
          session_id: ticket.session_id,
          conversation_id: ticket.conversation_id || ticket.session_id,
          branch_id: cueId,
          turn_id: state.turnId,
          format: {
            encoding: "pcm16",
            sample_rate: 16000,
            channels: 1,
          },
        }));
      };
      state.ws.onmessage = (event) => handleLiveVoiceMessage(state, event);
      state.ws.onerror = () => finishLiveVoiceError(state, "Live voice connection failed.");
      state.ws.onclose = () => {
        if (liveVoice === state && !state.committed) {
          finishLiveVoiceError(state, "Live voice connection closed.");
        }
      };
    } catch (error) {
      finishLiveVoiceError(state, String(error?.message || error));
    }
  }

  function startMicrophonePump(state) {
    if (!state.stream || !audioCtx || state.processor) return;
    const source = audioCtx.createMediaStreamSource(state.stream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      event.outputBuffer.getChannelData(0).fill(0);
      if (liveVoice !== state || !state.sessionReady || state.committed) return;
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
      const inputSamples = event.inputBuffer.getChannelData(0);
      const pcm = resampleToPcm16(inputSamples, state.sampleRate || audioCtx.sampleRate, 16000, state.resample);
      if (pcm.byteLength > 0) state.ws.send(pcm);
    };
    source.connect(processor);
    processor.connect(audioCtx.destination);
    state.source = source;
    state.processor = processor;
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

  function handleLiveVoiceMessage(state, event) {
    if (event.data instanceof ArrayBuffer) {
      playLiveAssistantPcm(state, event.data);
      return;
    }
    if (event.data instanceof Blob) {
      event.data.arrayBuffer().then((buffer) => playLiveAssistantPcm(state, buffer));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(String(event.data || "{}"));
    } catch {
      return;
    }

    if (msg.type === "session_ready") {
      state.sessionReady = true;
      startMicrophonePump(state);
      updateCue(state.cueId, "listening...", "running");
      return;
    }
    if (msg.type === "profile_applied") {
      return;
    }
    if (msg.type === "transcript_partial" || msg.type === "transcript_final") {
      const text = String(msg.text || "").trim();
      if (!text) return;
      state.transcript = text;
      setTranscript(text, msg.type === "transcript_partial");
      updateCueLabel(state.cueId, text);
      return;
    }
    if (msg.type === "assistant_text") {
      const text = String(msg.text || "").trim();
      if (!text) return;
      state.assistantText = text;
      updateCue(state.cueId, text, "running");
      return;
    }
    if (msg.type === "assistant_audio_start") {
      setVoiceState(false);
      setAgentState("speaking");
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
      finishLiveVoiceError(state, msg.message || "Live voice failed.");
    }
  }

  function playLiveAssistantPcm(state, buffer) {
    if (!buffer || !buffer.byteLength) return;
    if (liveVoice !== state) return;
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
    if (!state) return;
    state.committed = true;
    stopLiveCapture(state);
    setVoiceState(false);
    setAgentState("thinking");
    setTranscript(state.transcript || "Thinking...", !state.transcript);
    updateCue(state.cueId, "thinking...", "running");
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "commit_turn", turn_id: state.turnId }));
    } else {
      finishLiveVoiceError(state, "Live voice connection was not open.");
    }
  }

  function stopLiveVoiceTurn(mode = "stop") {
    const state = liveVoice;
    if (!state) return;
    stopLiveCapture(state);
    stopLivePlayback(state);
    try {
      if (state.ws?.readyState === WebSocket.OPEN && mode === "cancel") {
        state.ws.send(JSON.stringify({ type: "cancel_turn", turn_id: state.turnId }));
      }
    } catch {}
    try {
      state.ws?.close(1000, mode);
    } catch {}
    if (liveVoice === state) liveVoice = null;
    setVoiceState(false);
    if (agentState !== "idle") setAgentState("idle");
  }

  function stopLiveCapture(state) {
    try {
      state.processor?.disconnect();
    } catch {}
    try {
      state.source?.disconnect();
    } catch {}
    for (const track of state.stream?.getTracks?.() || []) {
      try {
        track.stop();
      } catch {}
    }
    state.processor = null;
    state.source = null;
    state.stream = null;
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

  function finishLiveVoiceDone(state) {
    if (liveVoice !== state) return;
    const summary = state.assistantText || "Done.";
    updateCue(state.cueId, summary, "done");
    reactLauncher("done");
    stopLiveCapture(state);
    try {
      state.ws?.close(1000, "turn done");
    } catch {}
    liveVoice = null;
    setVoiceState(false);
    const delayMs = Math.max(0, ((state.playbackTime || 0) - (audioCtx?.currentTime || 0)) * 1000);
    setTimeout(() => {
      if (!liveVoice && agentState !== "idle") setAgentState("idle");
    }, delayMs + 120);
  }

  function finishLiveVoiceError(state, message) {
    if (liveVoice !== state) return;
    updateCue(state.cueId, message, "error");
    reactLauncher("error");
    stopLiveVoiceTurn("error");
  }

  function toggleVoice() {
    if (liveVoice && listening) {
      commitLiveVoiceTurn();
      return;
    }
    if (liveVoice) {
      stopLiveVoiceTurn("cancel");
    }
    startLiveVoiceTurn();
  }

  function toggleVoiceSession() {
    toggleVoice();
  }

  // ---- Hotkeys: Cmd/Ctrl+. = voice, Cmd/Ctrl+K = text ------------------
  // Two ways in, both hands-on-keyboard, no clicking:
  //   ⌘.  (or Ctrl+.)         → wake the agent and listen (speech); again to run
  //   ⌘K  (or Ctrl+K)         → open the text command field

  function isVoiceHotkey(e) {
    return (e.metaKey || e.ctrlKey) && e.key === ".";
  }

  function isTextHotkey(e) {
    return (e.metaKey || e.ctrlKey) && String(e.key || "").toLowerCase() === "k";
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
      // ⌘K → text command field.
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

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
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
    return { url: location.href, title: document.title, elements: out };
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
      if (needsConfirmation(el, req) && !(await askInlineConfirm(`Let agee ${req.action} "${label(el || document.activeElement) || "this element"}"?`))) {
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
      case "snapshot":
        reply(snapshot());
        return true;
      case "act":
        act(msg).then(reply);
        return true;
      case "confirm":
        askInlineConfirm(msg.text || "Allow agee to continue?").then((ok) => reply({ ok }));
        return true;
      case "progress":
        updateCue(msg.cueId, msg.text, "running");
        return false;
      case "done":
        updateCue(msg.cueId, msg.summary, "done");
        reactLauncher("done"); // hop + ring + happy chime
        // Text-command replies render in the current card only. Voice replies are
        // streamed through the Live WebSocket path, not browser text-to-speech.
        if (agentState === "thinking") setAgentState("idle");
        return false;
      case "error":
        updateCue(msg.cueId, msg.text, "error");
        reactLauncher("error"); // shake + ring + falling chime
        if (agentState === "thinking" || agentState === "speaking") setAgentState("idle");
        return false;
    }
  });

  build();
})();
