(() => {
  const DEFAULTS = Object.freeze({
    tapWindowMs: 280,
    tapSlopPx: 28,
    directionalDeadzonePx: 24,
    directionalBias: 1.25,
  });

  function distanceSquared(a, b) {
    const dx = Number(a?.x || 0) - Number(b?.x || 0);
    const dy = Number(a?.y || 0) - Number(b?.y || 0);
    return dx * dx + dy * dy;
  }

  function continueTapChain(chain, point, options = {}) {
    const cfg = { ...DEFAULTS, ...options };
    const nextPoint = {
      time: Number(point?.time || 0),
      x: Number(point?.x || 0),
      y: Number(point?.y || 0),
    };
    if (!chain) {
      return { count: 1, point: nextPoint };
    }
    const withinWindow =
      nextPoint.time - Number(chain.point?.time || 0) >= 0 &&
      nextPoint.time - Number(chain.point?.time || 0) <= cfg.tapWindowMs;
    const withinSlop = distanceSquared(nextPoint, chain.point) <= cfg.tapSlopPx * cfg.tapSlopPx;
    if (!withinWindow || !withinSlop) {
      return { count: 1, point: nextPoint };
    }
    return { count: Math.min(Number(chain.count || 0) + 1, 4), point: nextPoint };
  }

  function resolveTapAction({ tapCount, listening, conversationActive }) {
    const count = Math.max(1, Number(tapCount || 1));
    if (count === 1) {
      return listening || conversationActive ? "toggle_send" : "toggle_voice";
    }
    if (count === 2) return "new_voice";
    if (count === 3) return "open_text";
    return "noop";
  }

  function resolveVoiceFirstTransition({ tapCount, capturing, captureOrigin } = {}) {
    const count = Math.max(1, Number(tapCount || 1));
    const active = capturing === true;
    if (count === 1) return active ? "commit_current" : "start_current";
    if (count === 2) {
      if (active && captureOrigin === "double") return "commit_new";
      return active ? "cancel_then_start_new" : "start_new";
    }
    if (count === 3) return active ? "cancel_then_open_chat" : "open_chat";
    return "noop";
  }

  function latchAdmission({ voiceFirstEnabled, draftControlsEnabled } = {}) {
    const voiceFirst = voiceFirstEnabled === true;
    return Object.freeze({
      voiceFirstEnabled: voiceFirst,
      draftControlsEnabled: voiceFirst && draftControlsEnabled === true,
    });
  }

  function resolveHoldDirection(start, end, options = {}) {
    const cfg = { ...DEFAULTS, ...options };
    const dx = Number(end?.x || 0) - Number(start?.x || 0);
    const dy = Number(end?.y || 0) - Number(start?.y || 0);
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const deadzone = cfg.directionalDeadzonePx;
    if (absX < deadzone && absY < deadzone) return "release";
    if (absX >= absY * cfg.directionalBias) {
      return dx < 0 ? "left" : "release";
    }
    if (absY >= absX * cfg.directionalBias) {
      return dy < 0 ? "up" : "down";
    }
    return "release";
  }

  function resolveDraftHoldAction({ start, end, pointerCancel, draftControlsEnabled }, options = {}) {
    if (pointerCancel) return "discard_turn";
    if (draftControlsEnabled !== true) return "commit_turn";
    const direction = resolveHoldDirection(start, end, options);
    if (direction === "left") return "pause_capture";
    if (direction === "up") return "park_turn";
    if (direction === "down") return "discard_turn";
    return "commit_turn";
  }

  globalThis.AgeeVoiceCaptureGesture = {
    DEFAULTS,
    continueTapChain,
    latchAdmission,
    resolveTapAction,
    resolveVoiceFirstTransition,
    resolveHoldDirection,
    resolveDraftHoldAction,
  };
})();
