// The tap chain behind the voice-first companion gestures.
//
// It answers three questions and nothing else: which run of clicks does this
// press belong to, when has a still press become push-to-talk, and when is a
// run finished enough to act on. Everything a click then *means* — talk,
// branch, type — stays in content.js, because that needs the voice machine.
//
// Membership is decided at press-down (the up-to-down window), so a pending
// single-tap resolution can never fire in the middle of a double- or
// triple-click. A run resolves only after the multi-click window has passed:
// a single click that would send an active capture waits long enough for a
// second or third click to supersede it, so collisions never send by accident.
(() => {
  function create({
    windowMs = 280,
    slopPx = 28,
    holdMs = 340,
    onHold = () => {},
    onResolve = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    let chain = null;
    let holdTimer = null;

    function clearHoldTimer() {
      if (!holdTimer) return;
      clearTimer(holdTimer);
      holdTimer = null;
    }

    function reset() {
      if (chain?.timer) clearTimer(chain.timer);
      chain = null;
    }

    // Records the press and arms the hold. Returns how many taps are already
    // in the run this press joins — 0 when it starts a fresh one.
    function press(event) {
      clearHoldTimer();
      const gap = chain ? Number(event.timeStamp) - chain.lastTime : Infinity;
      const dx = chain ? Number(event.clientX) - chain.x : 0;
      const dy = chain ? Number(event.clientY) - chain.y : 0;
      const joins = !!chain && gap >= 0 && gap <= windowMs && dx * dx + dy * dy <= slopPx * slopPx;
      let joined = 0;
      if (joins) {
        if (chain.timer) {
          clearTimer(chain.timer);
          chain.timer = null;
        }
        joined = chain.count;
      } else {
        reset();
      }
      const pointerId = event.pointerId;
      holdTimer = setTimer(() => {
        holdTimer = null;
        reset();
        onHold(pointerId);
      }, holdMs);
      return joined;
    }

    // Closes the press: the run now has one more tap, and it resolves once the
    // multi-click window expires without another press extending it.
    function tap(event, joined = 0) {
      reset();
      const run = {
        count: Number(joined || 0) + 1,
        lastTime: Number(event.timeStamp),
        x: Number(event.clientX),
        y: Number(event.clientY),
        timer: null,
      };
      chain = run;
      run.timer = setTimer(() => {
        run.timer = null;
        if (chain === run) chain = null;
        onResolve(run.count);
      }, windowMs);
    }

    return { press, tap, reset, clearHoldTimer };
  }

  globalThis.AgeeVoiceFirstTapChain = { create };
})();
