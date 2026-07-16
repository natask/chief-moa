import assert from "node:assert/strict";

await import(`../extension/content-proactive-controller-runtime.js?test=${Date.now()}`);
const { createContentProactiveControllerRuntime } = globalThis.AgeeContentProactiveControllerRuntime;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
  const calls = [];
  const notices = [];
  const indicators = [];
  const cards = [];
  const hidden = [];
  const cues = [];
  const updates = [];
  const errors = [];
  const timers = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  let cueSequence = 0;
  const document = {
    visibilityState: "visible",
    focused: true,
    hasFocus() { return this.focused; },
    addEventListener(type, handler) { documentListeners.set(type, handler); },
    removeEventListener(type, handler) {
      if (documentListeners.get(type) === handler) documentListeners.delete(type);
    },
  };
  const window = {
    addEventListener(type, handler) { windowListeners.set(type, handler); },
    removeEventListener(type, handler) {
      if (windowListeners.get(type) === handler) windowListeners.delete(type);
    },
  };
  const setTimer = (kind) => (callback, ms) => {
    const timer = { callback, cleared: false, kind, ms };
    timers.push(timer);
    return timer;
  };
  const clearTimer = (timer) => { timer.cleared = true; };
  const sensitivityQueue = [...(overrides.sensitivities || [])];
  const sensitivity = () => sensitivityQueue.length
    ? sensitivityQueue.shift()
    : (overrides.sensitivity || { suppressed: false, reason: "safe" });
  const helper = overrides.helper === undefined
    ? { classifyStructuralPage: () => ({ kind: "summary", title: "Summarize" }) }
    : overrides.helper;
  const signals = overrides.signals === undefined ? { article_count: 1 } : overrides.signals;
  const sendMessage = async (message) => {
    calls.push(message);
    if (overrides.sendMessage) return overrides.sendMessage(message, calls);
    if (message.cmd === "proactiveGrantStart") return { ok: true, grantId: "grant-1", expiresAt: 1500 };
    return { ok: true };
  };
  const runtime = createContentProactiveControllerRuntime({
    document,
    window,
    sendMessage,
    proactiveHelper: () => helper,
    proactiveSensitivity: sensitivity,
    collectProactiveSignals: () => signals,
    setIndicator: (active) => indicators.push(active),
    renderNotice: (title, body) => notices.push({ title, body }),
    renderCard: (card) => cards.push(card),
    hideCard: () => hidden.push(true),
    newCueId: () => `cue-${++cueSequence}`,
    createCue: (...args) => cues.push(args),
    updateCue: (...args) => updates.push(args),
    showCueError: (...args) => errors.push(args),
    setTimeout: setTimer("timeout"),
    clearTimeout: clearTimer,
    setInterval: setTimer("interval"),
    clearInterval: clearTimer,
    now: () => 1000,
    visibleDwellMs: 1200,
    confirmationTimeoutMs: 155000,
  });
  return {
    calls,
    cards,
    cues,
    document,
    documentListeners,
    errors,
    hidden,
    indicators,
    notices,
    runtime,
    timers,
    updates,
    windowListeners,
  };
}

{
  const h = createHarness({ sensitivity: { suppressed: true, reason: "password" } });
  assert.ok(Object.isFrozen(h.runtime));
  await h.runtime.startProactiveGrant();
  assert.deepEqual(h.indicators, [false]);
  assert.match(h.notices[0].body, /password/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.runtime.hasProactiveGrant(), false);
  assert.equal(h.runtime.shouldHandleProactiveRevocation("any"), true);
}

for (const response of [
  Promise.reject(new Error("offline")),
  { ok: false, suppressed: true, reason: "checkout" },
  { ok: false },
]) {
  const h = createHarness({ sendMessage: () => response });
  await h.runtime.startProactiveGrant();
  assert.equal(h.runtime.hasProactiveGrant(), false);
  assert.equal(h.notices.at(-1).title, "Local suggestions are off");
}

{
  const h = createHarness();
  await h.runtime.startProactiveGrant();
  assert.equal(h.runtime.hasProactiveGrant(), true);
  assert.deepEqual(h.indicators, [true]);
  assert.equal(h.timers.filter((timer) => timer.kind === "timeout").length, 2);
  assert.equal(h.timers.find((timer) => timer.ms === 1200).ms, 1200);
  assert.equal(h.timers.find((timer) => timer.ms === 500).ms, 500);
  assert.equal(h.timers.find((timer) => timer.kind === "interval").ms, 3000);
  assert.equal(h.runtime.shouldHandleProactiveRevocation("other"), false);
  assert.equal(h.runtime.shouldHandleProactiveRevocation("grant-1"), true);
  assert.equal(h.runtime.shouldHandleProactiveRevocation(""), true);
  h.runtime.stopProactiveGrant();
  assert.equal(h.runtime.hasProactiveGrant(), false);
  assert.equal(h.hidden.length, 1);
  assert.equal(h.calls.at(-1).cmd, "proactiveGrantStop");
  assert.equal(h.calls.at(-1).reason, "manual_stop");
  assert.ok(h.timers.every((timer) => timer.cleared));
  h.runtime.stopProactiveGrant("again", { showNotice: true, notify: false });
  assert.equal(h.hidden.length, 1);
}

{
  const h = createHarness();
  await h.runtime.sampleProactivePage();
  await h.runtime.checkProactiveGrantStatus();
  assert.deepEqual(h.calls, []);
}

{
  const h = createHarness();
  await h.runtime.startProactiveGrant();
  h.document.visibilityState = "hidden";
  await h.runtime.sampleProactivePage();
  assert.ok(h.documentListeners.has("visibilitychange"));
  const hiddenResume = h.documentListeners.get("visibilitychange");
  hiddenResume();
  assert.ok(h.documentListeners.has("visibilitychange"));
  h.document.visibilityState = "visible";
  h.document.focused = true;
  h.windowListeners.get("focus")();
  const immediate = h.timers.find((timer) => timer.ms === 0 && !timer.cleared);
  assert.ok(immediate);
  await immediate.callback();
  assert.equal(h.cards.length, 1);
}

{
  const h = createHarness({ sensitivities: [
    { suppressed: false, reason: "safe" },
    { suppressed: true, reason: "login" },
  ] });
  await h.runtime.startProactiveGrant();
  await h.runtime.sampleProactivePage();
  assert.equal(h.runtime.hasProactiveGrant(), false);
  assert.equal(h.notices.at(-1).title, "Local suggestions stopped");
  assert.equal(h.calls.at(-1).reason, "sensitive");
}

for (const override of [
  { signals: null },
  { helper: { classifyStructuralPage: () => null } },
]) {
  const h = createHarness(override);
  await h.runtime.startProactiveGrant();
  await h.runtime.sampleProactivePage();
  assert.equal(h.runtime.hasProactiveGrant(), false);
  assert.equal(h.notices.at(-1).title, "Local observation stopped");
}

for (const signalResponse of [Promise.reject(new Error("revoked")), { ok: false, reason: "expired" }]) {
  const h = createHarness({
    sendMessage: (message) => message.cmd === "proactiveGrantStart"
      ? { ok: true, grantId: "grant-1", expiresAt: 1500 }
      : signalResponse,
  });
  await h.runtime.startProactiveGrant();
  await h.runtime.sampleProactivePage();
  assert.equal(h.runtime.hasProactiveGrant(), false);
  assert.equal(h.calls.some((message) => message.cmd === "proactiveGrantStop"), false);
}

{
  const signal = deferred();
  const h = createHarness({
    sendMessage: (message) => message.cmd === "proactiveGrantStart"
      ? { ok: true, grantId: "grant-1", expiresAt: 1500 }
      : signal.promise,
  });
  await h.runtime.startProactiveGrant();
  const sampling = h.runtime.sampleProactivePage();
  h.runtime.stopProactiveGrant("race", { notify: false });
  signal.resolve({ ok: true });
  await sampling;
  assert.equal(h.cards.length, 0);
}

{
  const h = createHarness();
  await h.runtime.startProactiveGrant();
  await h.runtime.checkProactiveGrantStatus();
  assert.equal(h.runtime.hasProactiveGrant(), true);
  const failing = createHarness({
    sendMessage: (message) => message.cmd === "proactiveGrantStart"
      ? { ok: true, grantId: "grant-1", expiresAt: 1500 }
      : Promise.reject(new Error("status offline")),
  });
  await failing.runtime.startProactiveGrant();
  await failing.runtime.checkProactiveGrantStatus();
  assert.equal(failing.runtime.hasProactiveGrant(), false);
}

{
  const h = createHarness();
  await h.runtime.acceptProactiveCard({ title: "No grant" }, { disabled: false });
  await h.runtime.startProactiveGrant();
  await h.runtime.acceptProactiveCard({ title: "Disabled" }, { disabled: true });
  assert.equal(h.cues.length, 0);
}

{
  const h = createHarness({ sensitivities: [
    { suppressed: false, reason: "safe" },
    { suppressed: true, reason: "password" },
  ] });
  await h.runtime.startProactiveGrant();
  await h.runtime.acceptProactiveCard({ title: "Card" }, { disabled: false });
  assert.equal(h.runtime.hasProactiveGrant(), false);
  assert.equal(h.notices.at(-1).title, "Suggestion not sent");
}

for (const confirmationResponse of [{ ok: false, reason: "blocked" }, Promise.reject(new Error("window failed"))]) {
  const h = createHarness({
    sendMessage: (message) => {
      if (message.cmd === "proactiveGrantStart") return { ok: true, grantId: "grant-1", expiresAt: 1500 };
      if (message.cmd === "proactiveConfirmationOpen") return confirmationResponse;
      return { ok: true };
    },
  });
  await h.runtime.startProactiveGrant();
  const button = { disabled: false };
  await h.runtime.acceptProactiveCard({ kind: "summary", title: "Card" }, button);
  assert.equal(button.disabled, false);
  assert.equal(h.runtime.hasPendingProactiveConfirmation("cue-1"), false);
  assert.equal(h.errors.length, 1);
}

{
  const h = createHarness();
  await h.runtime.startProactiveGrant();
  const button = { disabled: false };
  await h.runtime.acceptProactiveCard({ kind: "summary", title: "Card" }, button);
  assert.equal(button.disabled, true);
  assert.equal(h.runtime.hasProactiveGrant(), false);
  assert.equal(h.runtime.hasPendingProactiveConfirmation("cue-1"), true);
  assert.ok(h.updates.some((entry) => entry[1] === "Review the extension-owned confirmation…"));
}

{
  const h = createHarness();
  h.runtime.trackProactiveConfirmationCue("status-cue");
  const statusTimer = h.timers.find((timer) => timer.kind === "interval");
  await statusTimer.callback();
  assert.equal(h.runtime.hasPendingProactiveConfirmation("status-cue"), true);
  h.runtime.trackProactiveConfirmationCue("status-cue");
  assert.equal(statusTimer.cleared, true);
  h.runtime.clearAllProactiveConfirmationCues();
  assert.equal(h.runtime.hasPendingProactiveConfirmation("status-cue"), false);
  h.runtime.clearProactiveConfirmationCue("missing");
}

{
  const check = deferred();
  const h = createHarness({
    sendMessage: (message) => message.cmd === "proactiveConfirmationStatus" ? check.promise : { ok: true },
  });
  h.runtime.trackProactiveConfirmationCue("concurrent");
  const interval = h.timers.find((timer) => timer.kind === "interval");
  const first = interval.callback();
  await interval.callback();
  check.resolve({ ok: false });
  await first;
  assert.equal(h.runtime.hasPendingProactiveConfirmation("concurrent"), false);
  assert.match(h.errors[0][1], /expired, closed/);
}

{
  const h = createHarness();
  h.runtime.trackProactiveConfirmationCue("expiry");
  const expiry = h.timers.find((timer) => timer.kind === "timeout");
  expiry.callback();
  assert.equal(h.runtime.hasPendingProactiveConfirmation("expiry"), false);
  assert.match(h.errors[0][1], /expired without sending/);
  expiry.callback();
  assert.equal(h.errors.length, 1);
}

console.log("content proactive controller runtime tests passed");
