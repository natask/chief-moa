(() => {
  function create({ root, launcher, request, onSend, onCancel, onDiscarded, onState, onProtocolError }) {
    const protocol = globalThis.AgeeVoiceDraftProtocol;
    const toolbar = document.createElement("div");
    toolbar.id = "agee-draft-controls";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Voice capture controls");
    toolbar.hidden = true;
    toolbar.innerHTML = `
      <button id="agee-draft-cancel" type="button" aria-label="Cancel and discard voice capture">Cancel</button>
      <button id="agee-draft-pause" type="button" aria-label="Pause voice capture">Pause</button>`;
    launcher.after(toolbar);
    const cancel = toolbar.querySelector("#agee-draft-cancel");
    const pause = toolbar.querySelector("#agee-draft-pause");
    let capability = null;
    let generation = 0;
    let binding = null;
    let pointer = null;
    let pendingAction = "";
    let starting = false;

    function supported() {
      return protocol.capabilityFresh(capability);
    }

    function active() {
      return Boolean(starting || (binding && !["sent", "discarded"].includes(pointer?.state)));
    }

    async function refreshCapability() {
      const requestGeneration = ++generation;
      const response = await request({ cmd: "voiceDraftCapability" }).catch(() => null);
      const accepted = protocol.acceptedCapabilityResponse(requestGeneration, generation, response);
      capability = accepted?.supported ? accepted : null;
      if (!supported() && !binding) render();
      return supported();
    }

    function position() {
      if (toolbar.hidden) {
        if (!root.querySelector("#agee-stop.visible")) root.classList.remove("agee-control-layout-impossible");
        return;
      }
      const mark = launcher.getBoundingClientRect();
      const controls = toolbar.getBoundingClientRect();
      const stop = root.querySelector("#agee-stop.visible");
      const stopRect = stop?.getBoundingClientRect();
      const layout = globalThis.AgeeRibbonLayout.companionControlPlacement({
        launcherRect: mark,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        controls: [
          { id: "draft", width: controls.width, height: controls.height },
          ...(stopRect?.width ? [{ id: "stop", width: stopRect.width, height: stopRect.height }] : []),
        ],
      });
      root.classList.toggle("agee-control-layout-impossible", layout.impossible === true);
      for (const placement of layout.placements) {
        const target = placement.id === "draft" ? toolbar : stop;
        if (!target) continue;
        target.style.left = `${placement.left}px`;
        target.style.top = `${placement.top}px`;
      }
    }

    function render() {
      const active = Boolean(starting || (binding?.draftMode && !["sent", "discarded"].includes(pointer?.state)));
      toolbar.hidden = !active;
      root.classList.toggle("agee-draft-active", active);
      root.classList.toggle("agee-draft-paused", active && pointer?.state === "paused");
      cancel.disabled = false;
      pause.disabled = Boolean(starting || !pointer || pendingAction);
      const paused = pointer?.state === "paused";
      pause.textContent = paused ? "Resume" : "Pause";
      pause.setAttribute("aria-label", paused ? "Resume voice capture" : "Pause voice capture");
      launcher.setAttribute("aria-label", active ? "Send voice to Ag" : "Ag");
      if (active) launcher.setAttribute("data-agee-tip", "Send voice");
      else launcher.removeAttribute("data-agee-tip");
      position();
      if (!active) root.dispatchEvent(new globalThis.CustomEvent("agee:position-companion-controls"));
    }

    function bind(value) {
      starting = false;
      binding = value?.draftMode === true ? {
        draftMode: true,
        voiceSessionId: protocol.authorityToken(value.voiceSessionId),
        operation: value.operation === "resume" ? "resume" : "create",
        sessionId: protocol.authorityToken(value.sessionId),
        branchId: protocol.authorityToken(value.branchId),
        turnId: protocol.authorityToken(value.turnId),
      } : null;
      pointer = null;
      pendingAction = "";
      render();
    }

    function begin(enabled = true) {
      starting = enabled === true;
      render();
    }

    function accept(message) {
      if (!binding) return { handled: false };
      let next = null;
      if (message?.type === "session_ready") {
        next = protocol.validateReady(message, { ...binding, pointer, operation: binding.operation });
      } else if (message?.type === "voice_draft_state") {
        next = protocol.validateState(message, { pointer, action: pendingAction || message?.voice_draft?.action });
      } else return { handled: false };
      if (!next) {
        onProtocolError?.("Gateway returned stale or mismatched voice-draft authority.");
        return { handled: true, accepted: false };
      }
      pointer = next;
      pendingAction = next.state === "send_ready" ? "send" : "";
      render();
      onState?.(next.state);
      if (next.state === "discarded") onDiscarded?.();
      return { handled: true, accepted: true, pointer: { ...next } };
    }

    async function control(action) {
      if (!binding || !pointer || pendingAction) return false;
      const message = protocol.controlRequest(action, pointer);
      if (!message) return false;
      pendingAction = action;
      render();
      const response = await request({ cmd: "voiceSessionControl", voiceSessionId: binding.voiceSessionId, message }).catch(() => null);
      if (response?.ok) return true;
      pendingAction = "";
      render();
      onProtocolError?.(response?.error || "Voice draft control failed.");
      return false;
    }

    function commitMessage() {
      if (!pointer || pendingAction || !["capturing", "paused", "parked"].includes(pointer.state)) return null;
      pendingAction = "send";
      render();
      return protocol.commitRequest(pointer);
    }

    function reset() {
      starting = false;
      binding = null;
      pointer = null;
      pendingAction = "";
      render();
    }

    cancel.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation();
      if (!pointer || pendingAction) onCancel?.();
      else control("discard");
    });
    pause.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation();
      control(pointer?.state === "paused" ? "resume" : "pause");
    });
    launcher.addEventListener("keydown", (event) => {
      if (!pointer || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      onSend?.();
    });
    addEventListener("resize", position);
    root.addEventListener("agee:position-companion-controls", position);
    refreshCapability();

    return Object.freeze({ accept, active, begin, bind, commitMessage, position, refreshCapability, reset, supported });
  }

  globalThis.AgeeVoiceDraftControls = Object.freeze({ create });
})();
