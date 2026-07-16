import assert from "node:assert/strict";

class FakeClassList {
  constructor(owner) { this.owner = owner; this.values = new Set(); }
  contains(value) { return this.values.has(value) || String(this.owner.className || "").split(/\s+/).includes(value); }
}

class FakeElement {
  constructor(id = "", ownerDocument = null) {
    this.id = id;
    this.ownerDocument = ownerDocument;
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.listeners = new Map();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this.type = "";
    this.removed = false;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node?.parentNode) node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
      if (node) node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  focus() { this.ownerDocument.activeElement = this; this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  remove() {
    this.removed = true;
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
  }
  cloneNode() { const copy = new FakeElement(this.id, this.ownerDocument); copy.className = this.className; return copy; }
  querySelector(selector) {
    if (selector === ".floating-note") return this.children.find((el) => el.classList?.contains("floating-note")) || null;
    return null;
  }
  setPointerCapture(id) { this.pointerCapture = id; }
  async emit(type, event = {}) {
    const supplied = { preventDefault() { supplied.defaultPrevented = true; }, ...event };
    for (const listener of this.listeners.get(type) || []) await listener(supplied);
    return supplied;
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.listeners = new Map();
    this.body = new FakeElement("body", this);
    this.head = new FakeElement("head", this);
    this.title = "";
    this.activeElement = null;
    this.styles = [new FakeElement("style", this)];
  }
  getElementById(id) { return this.elements.get(id) || null; }
  createElement(tag) { return new FakeElement(tag, this); }
  querySelectorAll(selector) {
    if (selector === "[data-agent-mode-option]") return [...this.elements.values()].filter((el) => el.dataset.agentModeOption);
    if (selector === "style") return this.styles;
    return [];
  }
  querySelector(selector) {
    if (selector === ".floating-note") return this.body.children.find((el) => el.classList?.contains("floating-note")) || null;
    return null;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  async emit(type, event = {}) {
    const supplied = { preventDefault() { supplied.defaultPrevented = true; }, ...event };
    for (const listener of this.listeners.get(type) || []) await listener(supplied);
    return supplied;
  }
}

const document = new FakeDocument();
for (const id of [
  "status", "log", "talk", "form", "text", "sendBtn", "agentModeSelector", "floatBtn",
  "settingsForm", "settingsSearch", "settingsRecommend", "settingsAll", "settingsResults", "settingsDetail",
]) {
  document.elements.set(id, new FakeElement(id, document));
}
for (const role of ["delegate", "help", "collaborate", "explain"]) {
  const button = new FakeElement(`role-${role}`, document);
  button.dataset.agentModeOption = role;
  document.elements.set(button.id, button);
}
document.body.append(...[
  "status", "agentModeSelector", "settingsForm", "settingsResults", "settingsDetail", "log", "talk", "form", "floatBtn",
].map((id) => document.getElementById(id)));

const timers = new Map();
let nextTimer = 1;
function fakeSetTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; }
function runTimer(delay) {
  const entry = [...timers.entries()].find(([, value]) => value.delay === delay);
  assert.ok(entry, `missing ${delay}ms timer`);
  timers.delete(entry[0]);
  entry[1].callback();
}

let responseOverrides = new Map();
let portMessageListener = null;
let disconnectListener = null;
const posted = [];
const port = {
  onMessage: { addListener(listener) { portMessageListener = listener; } },
  onDisconnect: { addListener(listener) { disconnectListener = listener; } },
  postMessage(message) {
    posted.push(message);
    const microphoneSetting = {
      id: "browser.microphone_permission",
      title: "Microphone permission",
      owner: "browser_extension",
      current: "denied",
      default: "prompt",
      description: "Chrome microphone access for browser voice.",
      constraints: ["Only the user can change this permission."],
      takes_effect: "next voice capture",
      redaction: "none",
      deep_link: { target: "microphone_permission", label: "Open microphone setup" },
    };
    const tokenSetting = {
      id: "browser.gateway_token",
      title: "Gateway token",
      owner: "browser_extension",
      current: "configured (value redacted)",
      default: "not configured",
      description: "Configured token state only.",
      constraints: ["Secret stays redacted."],
      takes_effect: "next gateway request",
      redaction: "configured state only",
    };
    const defaultResponses = {
      voiceSessionStart: { ok: true, voiceSessionId: "voice-session" },
      voiceSessionAttach: { ok: true },
      voiceSessionClose: { ok: true },
      voiceSessionControl: { ok: true },
      voiceTurnFetch: { turn: { assistant_text: "Recovered reply", transcript: "Recovered words" } },
      browserRoleTurn: { ok: true, summary: "Browser task done" },
      openOptions: { ok: true },
    };
    const settingsResponse = message.operation === "get"
      ? { ok: true, setting: message.id === tokenSetting.id ? tokenSetting : microphoneSetting }
      : { ok: true, settings: message.query === "token" ? [tokenSetting] : [microphoneSetting] };
    const configured = responseOverrides.has(message.cmd)
      ? responseOverrides.get(message.cmd)
      : message.cmd === "settingsQuery" ? settingsResponse : defaultResponses[message.cmd];
    if (configured === "throw") throw new Error("post failed");
    if (configured === "throw-string") throw "post failed string";
    if (configured === "silent") return;
    queueMicrotask(() => portMessageListener?.({ reqId: message.reqId, ...(configured || {}) }));
  },
};

const storageWrites = [];
let storageReject = false;
let storageChangeListener = null;
const chrome = {
  runtime: { connect() { return port; } },
  storage: {
    local: {
      async get() { if (storageReject) throw new Error("storage failed"); return { ageeBrowserAgentRole: "help" }; },
      async set(value) { storageWrites.push(value); },
    },
    onChanged: { addListener(listener) { storageChangeListener = listener; } },
  },
};

let audioConstructThrows = false;
let audioContext = null;
class FakeAudioContext {
  constructor() {
    if (audioConstructThrows) throw new Error("audio unavailable");
    this.state = "suspended";
    this.currentTime = 2;
    this.destination = {};
    this.resumed = 0;
    this.sources = [];
    audioContext = this;
  }
  async resume() { this.resumed += 1; this.state = "running"; }
  createBuffer(_channels, length, rate) {
    const channel = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => channel, channel };
  }
  createBufferSource() {
    const source = {
      playbackRate: { value: 0 }, stopped: 0, connected: null, onended: null,
      connect(value) { this.connected = value; },
      start(value) { this.started = value; },
      stop() { this.stopped += 1; },
    };
    this.sources.push(source);
    return source;
  }
}

const original = {
  AudioContext: globalThis.AudioContext,
  atob: globalThis.atob,
  chrome: globalThis.chrome,
  document: globalThis.document,
  documentPictureInPicture: globalThis.documentPictureInPicture,
  navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  window: globalThis.window,
};
globalThis.document = document;
globalThis.chrome = chrome;
globalThis.window = { AudioContext: FakeAudioContext };
globalThis.setTimeout = fakeSetTimeout;
globalThis.clearTimeout = (id) => timers.delete(id);

const panel = await import(`../extension/sidepanel.js?test=${Date.now()}`);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(document.getElementById("status").textContent, "Ready.");
assert.equal(document.getElementById("agentModeSelector").dataset.agentMode, "help");
assert.ok(storageChangeListener);
storageChangeListener({}, "sync");
storageChangeListener({}, "local");
storageChangeListener({ ageeBrowserAgentRole: { newValue: "collaborate" } }, "local");
assert.equal(document.getElementById("agentModeSelector").dataset.agentMode, "collaborate");

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { permissions: { query: async () => ({ state: "granted" }) } },
});
await panel.runSettingsQuery("list");
assert.equal(posted.at(-1).microphonePermission, "granted");
globalThis.navigator.permissions.query = async () => ({ state: "unsupported" });
await panel.runSettingsQuery("list");
assert.equal(posted.at(-1).microphonePermission, "unknown");
globalThis.navigator.permissions.query = async () => { throw new Error("permission unavailable"); };
await panel.runSettingsQuery("list");
assert.equal(posted.at(-1).microphonePermission, "unknown");
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
await panel.runSettingsQuery("list");
assert.equal(posted.at(-1).microphonePermission, "unknown");

document.getElementById("settingsSearch").value = "microphone";
await document.getElementById("settingsForm").emit("submit");
await new Promise((resolve) => setImmediate(resolve));
const settingsResults = document.getElementById("settingsResults");
assert.equal(settingsResults.hidden, false);
assert.equal(settingsResults.children[0].dataset.settingId, "browser.microphone_permission");
const typedMicrophoneId = settingsResults.children[0].dataset.settingId;
assert.equal(settingsResults.children[0].children[1].textContent, "Current: denied");
await settingsResults.children[0].emit("click");
await new Promise((resolve) => setImmediate(resolve));
const settingsDetail = document.getElementById("settingsDetail");
assert.equal(settingsDetail.hidden, false);
assert.match(settingsDetail.children[1].textContent, /Owner: browser_extension/);
assert.match(settingsDetail.children[1].textContent, /Current: denied/);
assert.match(settingsDetail.children[1].textContent, /Default: prompt/);
assert.match(settingsDetail.children[1].textContent, /Takes effect: next voice capture/);
assert.match(settingsDetail.children[1].textContent, /Redaction: none/);
assert.equal(settingsDetail.children[2].textContent, "Open microphone setup");
await settingsDetail.children[2].emit("click");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(posted.at(-1).cmd, "openOptions");
assert.equal(posted.at(-1).target, "microphone_permission");

responseOverrides.set("openOptions", { ok: false });
panel.renderSettingDetail({
  id: "browser.microphone_permission",
  current: null,
  default: [],
  deep_link: { target: "microphone_permission" },
});
let recoveryAction = settingsDetail.children[2];
await recoveryAction.emit("click");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(recoveryAction.disabled, false);
responseOverrides.set("openOptions", "throw");
panel.renderSettingDetail({ id: "browser.microphone_permission", deep_link: { target: "microphone_permission" } });
recoveryAction = settingsDetail.children[2];
await recoveryAction.emit("click");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(recoveryAction.disabled, false);
responseOverrides.delete("openOptions");

assert.match(panel.settingMetadata({ current: {}, default: "", constraints: [] }), /Owner: unknown/);
assert.match(panel.settingMetadata({ current: [], default: undefined }), /Current: None/);
responseOverrides.set("settingsQuery", { ok: false });
await panel.selectSetting({ id: "browser.gateway_token", title: "Fallback title", current: "fallback" });
assert.equal(settingsDetail.children[0].textContent, "Fallback title");
responseOverrides.delete("settingsQuery");

panel.renderSettingsResults({ error: "catalog offline" });
assert.match(settingsResults.children[0].textContent, /catalog offline/);
panel.renderSettingsResults({ settings: [] });
assert.match(settingsResults.children[0].textContent, /No registered settings/);
document.getElementById("settingsSearch").value = "";
assert.equal(await panel.runSettingsQuery("search"), null);
assert.equal(document.activeElement, document.getElementById("settingsSearch"));
assert.equal(await panel.runSettingsQuery("recommend"), null);
assert.equal(await panel.projectSpokenSettingsQuery({ settingsQueryRendered: true }, "show all settings"), null);
assert.equal(await panel.projectSpokenSettingsQuery({}, "hello there"), null);
responseOverrides.set("settingsQuery", {
  ok: true,
  setting: { id: "browser.agent_role", title: "Role", current: "help" },
  gateway_error: "offline",
});
const exactSpoken = await panel.projectSpokenSettingsQuery({}, "Get setting browser.agent_role");
assert.equal(exactSpoken.settings[0].id, "browser.agent_role");
assert.match(document.getElementById("status").textContent, /Browser settings shown/);
responseOverrides.delete("settingsQuery");

responseOverrides.set("settingsQuery", "throw");
document.getElementById("settingsSearch").value = "privacy";
await document.getElementById("settingsRecommend").emit("click");
await document.getElementById("settingsAll").emit("click");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(document.getElementById("status").dataset.state, "error");
responseOverrides.delete("settingsQuery");

document.getElementById("settingsSearch").value = "token";
await panel.runSettingsQuery("search");
await settingsResults.children[0].emit("click");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(settingsDetail.children.length, 2);
assert.match(settingsDetail.children[1].textContent, /configured \(value redacted\)/);
assert.doesNotMatch(JSON.stringify(posted), /must-never-appear/);
const spokenProjection = await panel.projectSpokenSettingsQuery({}, "Find settings about microphone access");
assert.equal(spokenProjection.settings[0].id, typedMicrophoneId);
assert.equal(settingsResults.children[0].dataset.settingId, typedMicrophoneId);
assert.equal(posted.at(-1).operation, "search");
await document.emit("keydown", { key: "k", metaKey: true });
assert.equal(document.activeElement, document.getElementById("settingsSearch"));

panel.setAgentRole("EXPLAIN");
assert.deepEqual(storageWrites.at(-1), { ageeBrowserAgentRole: "explain" });
panel.setAgentRole(null, { persist: false });
panel.setAgentRole("invalid", { persist: false });
assert.equal(document.getElementById("agentModeSelector").dataset.agentMode, "delegate");
await document.getElementById("role-help").emit("click");
assert.equal(document.getElementById("agentModeSelector").dataset.agentMode, "help");

panel.setStatus("Working", "speaking");
assert.equal(document.getElementById("status").dataset.state, "speaking");
assert.equal(panel.ensurePort(), port);
panel.onPortMessage(null);
panel.onPortMessage("bad");
panel.onPortMessage({ cmd: "unknown" });

const requestPromise = panel.request({ cmd: "voiceSessionControl" });
assert.equal((await requestPromise).ok, true);
responseOverrides.set("voiceSessionControl", "throw");
await assert.rejects(panel.request({ cmd: "voiceSessionControl" }), /post failed/);
responseOverrides.set("voiceSessionControl", "silent");
const timedOut = panel.request({ cmd: "voiceSessionControl" }, 1234);
runTimer(1234);
await assert.rejects(timedOut, /did not respond/);
responseOverrides.delete("voiceSessionControl");

responseOverrides.set("voiceSessionControl", "silent");
const interruptedRequest = panel.request({ cmd: "voiceSessionControl" });
disconnectListener();
await assert.rejects(interruptedRequest, /background restarted/);
responseOverrides.delete("voiceSessionControl");
assert.equal(panel.ensurePort(), port);

const card = panel.addTurnCard("");
assert.equal(card.you.textContent, "…");
panel.updateCard(null, { reply: "ignored" });
const cardState = { ui: card, replyText: "" };
panel.updateCard(cardState, { you: "", pendingLabel: "thinking", reply: "reply", error: "error" });
assert.equal(card.ag.textContent, "error");
const confirmation = panel.confirmDelegation(cardState);
assert.equal(card.ag.children.length, 2);
await card.ag.children[1].children[0].emit("click");
assert.equal(await confirmation, true);
const cancellation = panel.confirmDelegation(cardState);
await card.ag.children[1].children[1].emit("click");
assert.equal(await cancellation, false);

const alreadyDoneRecovery = panel.newTurnState("text", "done");
alreadyDoneRecovery.done = true;
panel.recoverTurn(alreadyDoneRecovery, "ignored");
const completedBeforeRecovery = panel.newTurnState("text", "done soon");
panel.recoverTurn(completedBeforeRecovery, "ignored");
completedBeforeRecovery.done = true;
runTimer(1500);
const noReplyRecovery = panel.newTurnState("text", "missing reply");
responseOverrides.set("voiceTurnFetch", { turn: {} });
panel.recoverTurn(noReplyRecovery, "fallback reply");
runTimer(1500);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(noReplyRecovery.ui.ag.textContent, "fallback reply");
const alternateRecovery = panel.newTurnState("text", "alternate");
responseOverrides.set("voiceTurnFetch", { turn: { reply_text: "Alternate reply" } });
panel.recoverTurn(alternateRecovery, "fallback");
runTimer(1500);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(alternateRecovery.ui.ag.textContent, "Alternate reply");
responseOverrides.delete("voiceTurnFetch");

assert.equal(new Uint8Array(panel.base64ToBuffer("QUI="))[0], 65);
assert.equal(panel.base64ToBuffer("").byteLength, 0);
panel.playAssistantPcm(null);
audioConstructThrows = true;
panel.primeAudio();
audioConstructThrows = false;
panel.playAssistantPcm(new Int16Array([-32768, 16384]).buffer);
assert.equal(audioContext.resumed, 1);
assert.equal(audioContext.sources[0].playbackRate.value, 1);
audioContext.sources[0].onended();
panel.playAssistantPcm(new Int16Array([1]).buffer);
audioContext.sources.at(-1).stop = () => { throw new Error("already stopped"); };
panel.stopPlayback();

const simpleState = panel.newTurnState("voice", "hello");
panel.armWatchdog(simpleState);
runTimer(90000);
assert.equal(simpleState.done, true);
panel.finishTurn(simpleState);
const closedState = panel.newTurnState("voice", "close");
closedState.voiceSessionId = "close-me";
panel.closeTurnSession(closedState, "test");
assert.equal(closedState.voiceSessionId, null);
panel.failTurn(closedState, "failed");
panel.failTurn(closedState, "ignored");

let active = await panel.startTurn("voice", { youText: "" });
assert.equal(active.voiceSessionId, "voice-session");
assert.equal(await panel.startTurn("voice", { youText: "" }), null);
panel.onPortMessage({ cmd: "voiceSessionEvent", event: { type: "session_ready" } });
panel.handleVoiceEvent({ voiceSessionId: "other", event: { type: "session_ready" } });
panel.handleVoiceEvent({ event: {} });
panel.handleVoiceEvent({ type: "transcript_partial", text: "Direct payload" });
panel.handleVoiceEvent({ event: { type: "session_ready" } });
panel.handleVoiceEvent({ event: { type: "transcript_partial", text: "  " } });
panel.handleVoiceEvent({ event: { type: "transcript_final", text: "Heard" } });
panel.handleVoiceEvent({ event: { type: "assistant_text", text: "Reply" } });
panel.handleVoiceEvent({ event: { type: "assistant_audio_start", playback_rate: 1.25 } });
panel.handleVoiceEvent({ event: { type: "assistant_audio_start", playback_rate: 0 } });
panel.handleVoiceEvent({ audio: "AQA=" });
panel.handleVoiceEvent({ event: { type: "turn_done", status: "completed" } });
assert.equal(active.done, true);
panel.handleVoiceEvent({ event: { type: "assistant_text", text: "ignored" } });

active = await panel.startTurn("voice", { youText: "" });
panel.handleVoiceEvent({ event: { type: "turn_done", status: "error", error: "provider failed" } });
assert.match(active.ui.ag.textContent, /provider failed/);
active = await panel.startTurn("voice", { youText: "" });
panel.handleVoiceEvent({ event: { type: "turn_done", status: "error" } });
assert.match(active.ui.ag.textContent, /Voice turn failed/);
active = await panel.startTurn("voice", { youText: "" });
panel.handleVoiceEvent({ event: { type: "turn_done", status: "no_speech" } });
assert.equal(active.done, true);
active = await panel.startTurn("voice", { youText: "" });
panel.handleVoiceEvent({ event: { type: "turn_done", status: "completed" } });
runTimer(1500);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(active.done, true);
active = await panel.startTurn("voice", { youText: "" });
panel.handleVoiceEvent({ event: {
  type: "error",
  code: "microphone_capture_failed",
  message: "Microphone needs attention.",
  recovery: { target: "microphone_permission", action_label: "Take me to microphone setup" },
} });
assert.equal(active.done, true);
assert.equal(active.ui.ag.children[1].textContent, "Take me to microphone setup");
await active.ui.ag.children[1].emit("click");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(posted.at(-1).cmd, "openOptions");
assert.equal(posted.at(-1).target, "microphone_permission");

active = await panel.startTurn("voice", { youText: "" });
panel.handleVoiceEvent({ event: { type: "connection_closed" } });
runTimer(1500);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(active.done, true);

active = await panel.startTurn("text", { youText: "typed" });
panel.handleVoiceEvent({ event: { type: "session_ready" } });
panel.handleVoiceEvent({ event: { type: "error", recoverable: true, message: "dropped" } });
runTimer(1500);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(active.done, true);
assert.equal(active.ui.ag.textContent, "Recovered reply");

responseOverrides.set("voiceSessionStart", {
  ok: false,
  error: "Chrome denied microphone access.",
  code: "microphone_capture_failed",
  failure_code: "microphone_permission_denied",
  recovery: { target: "microphone_permission", action_label: "Take me to microphone setup" },
});
assert.equal(await panel.startTurn("voice", { youText: "" }), null);
let startFailureCard = document.getElementById("log").children.at(-1);
assert.equal(startFailureCard.children[1].children[1].textContent, "Take me to microphone setup");
await startFailureCard.children[1].children[1].emit("click");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(posted.at(-1).cmd, "openOptions");
assert.equal(posted.at(-1).target, "microphone_permission");

responseOverrides.set("voiceSessionStart", {
  ok: false,
  error: "Reload the extension.",
  code: "offscreen_runtime_unavailable",
  failure_code: "offscreen_runtime_unavailable",
  recovery: { target: "microphone_permission", action_label: "Must not render" },
});
assert.equal(await panel.startTurn("voice", { youText: "" }), null);
startFailureCard = document.getElementById("log").children.at(-1);
assert.equal(startFailureCard.children[1].children.length, 0);
assert.equal(startFailureCard.children[1].textContent, "Reload the extension.");

responseOverrides.set("voiceSessionStart", { ok: false, error: "start denied" });
assert.equal(await panel.startTurn("voice", { youText: "" }), null);
responseOverrides.set("voiceSessionStart", { ok: true });
assert.equal(await panel.startTurn("voice", { youText: "" }), null);
responseOverrides.set("voiceSessionStart", { ok: true, voiceSessionId: "attach-fail" });
responseOverrides.set("voiceSessionAttach", { ok: false });
assert.equal(await panel.startTurn("voice", { youText: "" }), null);
responseOverrides.set("voiceSessionStart", "throw-string");
assert.equal(await panel.startTurn("voice", { youText: "" }), null);
responseOverrides.delete("voiceSessionStart");
responseOverrides.delete("voiceSessionAttach");

await panel.beginHold();
assert.equal(document.getElementById("talk").dataset.state, "listening");
panel.commitHold();
await new Promise((resolve) => setImmediate(resolve));
panel.handleVoiceEvent({ event: { type: "assistant_text", text: "Done" } });
panel.handleVoiceEvent({ event: { type: "turn_done" } });
panel.commitHold();

responseOverrides.set("voiceSessionStart", { ok: false });
await panel.beginHold();
assert.equal(document.getElementById("talk").dataset.state, "idle");
responseOverrides.delete("voiceSessionStart");

responseOverrides.set("voiceSessionStart", "silent");
const earlyRelease = panel.beginHold();
panel.commitHold();
const startPost = posted.at(-1);
portMessageListener({ reqId: startPost.reqId, ok: true, voiceSessionId: "early-release" });
await new Promise((resolve) => setImmediate(resolve));
const attachPost = posted.at(-1);
portMessageListener({ reqId: attachPost.reqId, ok: true });
await earlyRelease;
panel.handleVoiceEvent({ event: { type: "error", recoverable: false, message: "cleanup" } });
responseOverrides.delete("voiceSessionStart");

document.activeElement = document.getElementById("text");
await document.emit("keydown", { code: "Space", repeat: false });
document.activeElement = null;
await document.emit("keydown", { code: "KeyA", repeat: false });
await document.emit("keydown", { code: "Space", repeat: true });
await document.emit("keydown", { code: "Space", repeat: false });
await new Promise((resolve) => setImmediate(resolve));
await document.emit("keyup", { code: "Space" });
await document.emit("keyup", { code: "KeyA" });
document.activeElement = document.getElementById("text");
await document.emit("keyup", { code: "Space" });
document.activeElement = null;
panel.handleVoiceEvent({ event: { type: "assistant_text", text: "Done" } });
panel.handleVoiceEvent({ event: { type: "turn_done" } });

await document.getElementById("talk").emit("pointerdown", { pointerId: 7 });
await new Promise((resolve) => setImmediate(resolve));
await document.getElementById("talk").emit("pointercancel");
panel.handleVoiceEvent({ event: { type: "assistant_text", text: "Done" } });
panel.handleVoiceEvent({ event: { type: "turn_done" } });

globalThis.window.documentPictureInPicture = null;
await panel.floatOut();
assert.match(document.getElementById("status").textContent, /not available/);
const pipDocument = new FakeDocument();
let pagehide = null;
const pip = { document: pipDocument, addEventListener(type, listener) { if (type === "pagehide") pagehide = listener; }, close() { this.closed = true; } };
globalThis.window.documentPictureInPicture = { requestWindow: async () => pip };
globalThis.documentPictureInPicture = globalThis.window.documentPictureInPicture;
await panel.floatOut();
assert.equal(document.getElementById("floatBtn").textContent, "Unfloat");
await panel.floatOut();
assert.equal(pip.closed, true);
pagehide();
assert.equal(document.getElementById("floatBtn").textContent, "Float");
panel.restoreFromFloat();
globalThis.window.documentPictureInPicture.requestWindow = async () => { throw new Error("pip denied"); };
await panel.floatOut();
assert.match(document.getElementById("status").textContent, /pip denied/);
await document.getElementById("floatBtn").emit("click");

document.getElementById("text").value = " ";
await document.getElementById("form").emit("submit");
await document.getElementById("role-help").emit("click");
document.getElementById("text").value = "Help me";
await document.getElementById("form").emit("submit");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(document.getElementById("log").children.at(-1).children[1].textContent, "Browser task done");

active = await panel.startTurn("voice", { youText: "busy" });
document.getElementById("text").value = "Blocked while busy";
await document.getElementById("form").emit("submit");
panel.failTurn(active, "cleanup");

responseOverrides.set("browserRoleTurn", { ok: false });
document.getElementById("text").value = "Rejected role turn";
await document.getElementById("form").emit("submit");
await new Promise((resolve) => setImmediate(resolve));
assert.match(document.getElementById("log").children.at(-1).children[1].textContent, /rejected/);
responseOverrides.set("browserRoleTurn", { ok: true });
document.getElementById("text").value = "Default summary";
await document.getElementById("form").emit("submit");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(document.getElementById("log").children.at(-1).children[1].textContent, "Done.");
responseOverrides.delete("browserRoleTurn");

await document.getElementById("role-delegate").emit("click");
document.getElementById("text").value = "Delegate this";
const submit = document.getElementById("form").emit("submit");
await new Promise((resolve) => setImmediate(resolve));
const delegateCard = document.getElementById("log").children.at(-1);
await delegateCard.children[1].children[1].children[1].emit("click");
await submit;
assert.equal(delegateCard.children[1].textContent, "Delegation cancelled.");

active = await panel.startTurn("voice", { youText: "disconnect" });
disconnectListener();
assert.equal(active.done, true);
assert.equal(document.getElementById("status").dataset.state, "error");

globalThis.chrome = original.chrome;
globalThis.document = original.document;
globalThis.documentPictureInPicture = original.documentPictureInPicture;
if (original.navigatorDescriptor) Object.defineProperty(globalThis, "navigator", original.navigatorDescriptor);
else delete globalThis.navigator;
globalThis.setTimeout = original.setTimeout;
globalThis.clearTimeout = original.clearTimeout;
globalThis.window = original.window;
if (original.AudioContext === undefined) delete globalThis.AudioContext;
else globalThis.AudioContext = original.AudioContext;
if (original.atob === undefined) delete globalThis.atob;
else globalThis.atob = original.atob;

console.log("sidepanel runtime tests passed");
