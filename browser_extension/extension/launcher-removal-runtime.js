(() => {
  const DEFAULTS = Object.freeze({ movementThresholdPx: 8 });

  function point(input = {}) {
    return {
      x: Number.isFinite(Number(input.x ?? input.clientX)) ? Number(input.x ?? input.clientX) : 0,
      y: Number.isFinite(Number(input.y ?? input.clientY)) ? Number(input.y ?? input.clientY) : 0,
    };
  }

  function isInside(input, rect) {
    if (!rect) return false;
    const current = point(input);
    return current.x >= Number(rect.left) &&
      current.x <= Number(rect.right) &&
      current.y >= Number(rect.top) &&
      current.y <= Number(rect.bottom);
  }

  function begin({ pointerId, x, y, clientX, clientY } = {}) {
    const start = point({ x: x ?? clientX, y: y ?? clientY });
    return Object.freeze({
      pointerId,
      start,
      current: start,
      moved: false,
      targetVisible: false,
      armed: false,
    });
  }

  function move(state, input = {}, targetRect, options = {}) {
    if (!state || input.pointerId !== state.pointerId) return state;
    const current = point(input);
    const dx = current.x - state.start.x;
    const dy = current.y - state.start.y;
    const threshold = Number(options.movementThresholdPx ?? DEFAULTS.movementThresholdPx);
    const moved = state.moved || dx * dx + dy * dy >= threshold * threshold;
    return Object.freeze({
      ...state,
      current,
      moved,
      targetVisible: moved,
      armed: moved && isInside(current, targetRect),
    });
  }

  function finish(state, input = {}, targetRect) {
    if (!state || input.pointerId !== state.pointerId) {
      return Object.freeze({ action: "ignore", removed: false, targetVisible: state?.targetVisible === true });
    }
    if (input.type === "pointercancel") {
      return Object.freeze({ action: "cancel", removed: false, targetVisible: false });
    }
    const insideAtRelease = state.moved && isInside(input, targetRect);
    return Object.freeze({
      action: insideAtRelease ? "remove" : state.moved ? "persist_position" : "tap",
      removed: insideAtRelease,
      targetVisible: false,
    });
  }

  globalThis.AgeeLauncherRemoval = Object.freeze({ DEFAULTS, begin, move, finish, isInside });
})();
