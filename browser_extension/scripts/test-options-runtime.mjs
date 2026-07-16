import assert from "node:assert/strict";

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.checked = false;
    this.style = {};
    this.children = [];
    this._textContent = "";
    this.innerHTML = "";
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.attributes = {};
  }
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  async emit(type, event = {}) {
    const supplied = {
      key: "",
      preventDefault() { supplied.defaultPrevented = true; },
      ...event,
    };
    for (const listener of this.listeners.get(type) || []) await listener(supplied);
    return supplied;
  }
}

const ids = [
  "gatewayUrl", "gatewayToken", "status", "micStatus", "profileState", "changeBox",
  "talkResult", "profileScope", "systemPrompt", "profileModel", "modelOptions",
  "temperature", "voiceMaxChars", "voiceName", "language", "inputLanguages",
  "languageOptions", "replyLanguageSelected", "replyLanguageSearch",
  "replyLanguageOptions", "heardLanguageSelected", "heardLanguageSearch",
  "heardLanguageOptions", "profileCatalogState", "profileStatus", "companionSearch",
  "companionList", "companionDetails", "companionPrompt", "companionStatus",
  "livekitVoice", "livekitVoiceStatus", "voiceFirstGestures", "voiceFirstGesturesStatus",
  "backgroundAutomation", "backgroundAutomationStatus", "save", "testGateway",
  "grantMic", "checkMic", "saveProfile", "refreshProfile", "searchCompanions",
  "createCompanion", "previewCompanion", "applyCompanion", "resetProfile", "applyChange",
];
const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
const document = {
  getElementById(id) { return elements.get(id) || null; },
  createElement(tag) { return new FakeElement(tag); },
};

const stored = {
  ageeGatewayUrl: "",
  ageeGatewayToken: "",
  ageeGatewayUserSet: true,
  ageeLivekitVoiceEnabled: true,
  ageeVoiceFirstGesturesEnabled: true,
  ageeVoiceFirstGesturesContractVersion: 1,
  ageeBackgroundAutomationEnabled: true,
  ageeBackgroundAutomationConsentVersion: 1,
};
const storageWrites = [];
let storageListener = null;
const chrome = {
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: stored[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]]));
        return Object.fromEntries(Object.keys(keys || {}).map((key) => [key, key in stored ? stored[key] : keys[key]]));
      },
      async set(values) { Object.assign(stored, values); storageWrites.push(values); },
    },
    onChanged: { addListener(listener) { storageListener = listener; } },
  },
};

let permissionState = "prompt";
let mediaFailure = null;
let stoppedTracks = 0;
const navigator = {
  permissions: { async query() { return { state: permissionState }; } },
  mediaDevices: {
    async getUserMedia() {
      if (mediaFailure) throw mediaFailure;
      return { getTracks: () => [{ stop() { stoppedTracks += 1; } }] };
    },
  },
};

const original = {
  chrome: globalThis.chrome,
  document: globalThis.document,
  fetch: globalThis.fetch,
  navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  setTimeout: globalThis.setTimeout,
};
globalThis.chrome = chrome;
globalThis.document = document;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
globalThis.setTimeout = () => 1;
globalThis.fetch = async (url) => {
  if (String(url).startsWith("chrome-extension://")) return { ok: false };
  throw new Error(`unexpected fetch ${url}`);
};

const options = await import(`../extension/options.js?test=${Date.now()}`);
await new Promise((resolve) => setImmediate(resolve));

assert.equal(elements.get("gatewayUrl").value, "");
assert.equal(elements.get("livekitVoice").checked, true);
assert.equal(elements.get("voiceFirstGestures").checked, true);
assert.equal(elements.get("backgroundAutomation").checked, true);
assert.ok(storageListener);

assert.deepEqual(options.gatewayHeaders("token", true), {
  "content-type": "application/json", authorization: "Bearer token",
});
assert.deepEqual(options.gatewayHeaders("", false), {});
assert.equal(options.parseJsonOrNull(""), null);
assert.equal(options.parseJsonOrNull("bad"), null);
assert.deepEqual(options.parseJsonOrNull('{"ok":true}'), { ok: true });
assert.match(options.networkFailureMessage("http://10.147.17.10:8787", "/health", new Error("boom")), /old main-machine/);
assert.doesNotMatch(options.networkFailureMessage("https://gateway.test", "/health", new Error("Failed to fetch")), /\(Failed to fetch\)/);
assert.equal(options.escapeHtml('<a x="1">&'), "&lt;a x=&quot;1&quot;&gt;&amp;");
assert.deepEqual(options.splitLanguageCodes("en-US, am-ET, en-US, ,fr-FR"), ["en-US", "am-ET", "fr-FR"]);

elements.get("gatewayUrl").value = "https://gateway.test/";
elements.get("gatewayToken").value = " token ";
assert.deepEqual(options.gatewayConfig(), { url: "https://gateway.test", token: "token" });

delete stored.ageeDeviceId;
const generatedDeviceId = await options.getStableDeviceId();
assert.match(generatedDeviceId, /^browser_[0-9a-f]{32}$/);
assert.equal(await options.getStableDeviceId(), generatedDeviceId);
elements.get("profileScope").value = "global";
assert.equal(await options.profileQuery(), "");
elements.get("profileScope").value = "device";
assert.match(await options.profileQuery(), /^\?scope=device&device_id=browser_/);

await elements.get("livekitVoice").emit("change");
await elements.get("voiceFirstGestures").emit("change");
assert.equal(stored.ageeVoiceFirstGesturesContractVersion, 1);
elements.get("livekitVoice").checked = false;
await elements.get("livekitVoice").emit("change");
elements.get("voiceFirstGestures").checked = false;
await elements.get("voiceFirstGestures").emit("change");
elements.get("backgroundAutomation").checked = false;
await elements.get("backgroundAutomation").emit("change");
assert.equal(stored.ageeBackgroundAutomationConsentVersion, 0);
elements.get("backgroundAutomation").checked = true;
await elements.get("backgroundAutomation").emit("change");
assert.equal(stored.ageeBackgroundAutomationConsentVersion, 1);

elements.get("gatewayUrl").value = "not-a-url";
await elements.get("save").emit("click");
assert.match(elements.get("status").textContent, /full gateway URL/);
elements.get("gatewayUrl").value = "";
elements.get("gatewayToken").value = "secret";
await elements.get("save").emit("click");
assert.equal(stored.ageeGatewayUserSet, true);
assert.equal(stored.ageeGatewayToken, "");
assert.equal(elements.get("status").textContent, "Disconnected ✓");
elements.get("gatewayUrl").value = "https://gateway.test";
elements.get("gatewayToken").value = "token";
await elements.get("save").emit("click");
assert.equal(stored.ageeGatewayUrl, "https://gateway.test");

const responses = [];
globalThis.fetch = async (url) => {
  responses.push(String(url));
  if (String(url).endsWith("/health")) return { ok: true, status: 200, text: async () => '{"ok":true,"provider":"vertex","model":"gemini"}' };
  if (String(url).endsWith("/v1/sessions")) return { ok: true, status: 200 };
  throw new Error(`unexpected ${url}`);
};
await elements.get("testGateway").emit("click");
assert.match(elements.get("status").textContent, /token valid/);
assert.deepEqual(responses, ["https://gateway.test/health", "https://gateway.test/v1/sessions"]);

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "not-json" });
await elements.get("testGateway").emit("click");
assert.match(elements.get("status").textContent, /not a healthy Moa gateway/);
elements.get("gatewayUrl").value = "bad";
await elements.get("testGateway").emit("click");
assert.match(elements.get("status").textContent, /full gateway URL/);
elements.get("gatewayUrl").value = "https://gateway.test";
globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '{"ok":false}' });
await elements.get("testGateway").emit("click");
assert.match(elements.get("status").textContent, /503/);
globalThis.fetch = async () => { throw new Error("offline"); };
await elements.get("testGateway").emit("click");
assert.match(elements.get("status").textContent, /Could not reach/);

async function checkAuthResponse({ gatewayUrl = "https://gateway.test", token = "token", status = 401, ok = false, throws = false, provider = "vertex", model = "gemini" }) {
  elements.get("gatewayUrl").value = gatewayUrl;
  elements.get("gatewayToken").value = token;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/health")) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, provider, model }) };
    if (throws) throw new Error("auth offline");
    return { ok, status };
  };
  await elements.get("testGateway").emit("click");
  return elements.get("status").textContent;
}
assert.match(await checkAuthResponse({ status: 401 }), /saved token was rejected/);
assert.match(await checkAuthResponse({ token: "", status: 403, provider: "", model: "" }), /requires a device token/);
assert.match(await checkAuthResponse({ gatewayUrl: "http://10.147.17.6:8787", status: 401 }), /different gateway/);
assert.match(await checkAuthResponse({ gatewayUrl: "http://10.147.17.6:8787", ok: true, status: 200 }), /token valid/);
assert.match(await checkAuthResponse({ status: 429 }), /auth check returned 429/);
assert.match(await checkAuthResponse({ throws: true }), /auth check failed/);

assert.equal(await options.microphonePermissionState(), "prompt");
delete navigator.permissions;
assert.equal(await options.microphonePermissionState(), "unknown");
navigator.permissions = { async query() { throw new Error("unsupported"); } };
assert.equal(await options.microphonePermissionState(), "unknown");
navigator.permissions = { async query() { return {}; } };
assert.equal(await options.microphonePermissionState(), "unknown");
navigator.permissions = { async query() { return { state: permissionState }; } };
permissionState = "granted";
await elements.get("checkMic").emit("click");
assert.match(elements.get("micStatus").textContent, /granted/);
permissionState = "denied";
await elements.get("checkMic").emit("click");
assert.match(elements.get("micStatus").textContent, /blocked/);
permissionState = "prompt";
await elements.get("checkMic").emit("click");
assert.match(elements.get("micStatus").textContent, /not granted/);
await elements.get("grantMic").emit("click");
assert.equal(stoppedTracks, 1);
mediaFailure = new Error("permission denied");
await elements.get("grantMic").emit("click");
assert.match(elements.get("micStatus").textContent, /permission denied/);
mediaFailure = null;
navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() { throw new Error("already stopped"); } }] });
await elements.get("grantMic").emit("click");
navigator.mediaDevices.getUserMedia = async () => { throw "blocked"; };
await elements.get("grantMic").emit("click");
assert.match(elements.get("micStatus").textContent, /blocked/);

const profileOptions = {
  voices: [{ id: "chirp", tone_tags: ["warm"] }, { id: "" }],
  languages: [{ code: "en-US", label: "English", aliases: ["English"] }, { code: "am-ET", label: "Amharic" }, { code: "" }],
  models: [{ id: "gemini", provider: "vertex" }, { id: "" }],
};
elements.get("language").value = "en-US";
elements.get("inputLanguages").value = "am-ET";
options.renderProfileOptions(profileOptions);
assert.equal(elements.get("profileCatalogState").textContent, "Loaded 2 voices, 2 languages, and 2 model options from the gateway catalog.");
assert.equal(options.languageLabel("en-US"), "English (en-US)");
assert.equal(options.languageLabel("xx"), "xx");
assert.equal(elements.get("replyLanguageOptions").children.length, 2);
const firstReply = elements.get("replyLanguageOptions").children[0];
const firstCheckbox = firstReply.children[0];
firstCheckbox.checked = false;
await firstCheckbox.emit("change");
assert.equal(elements.get("language").value, "");
const refreshedCheckbox = elements.get("replyLanguageOptions").children[0].children[0];
refreshedCheckbox.checked = true;
await refreshedCheckbox.emit("change");
assert.equal(elements.get("language").value, "en-US");
const selectedPill = elements.get("replyLanguageSelected").children[0];
await selectedPill.children[0].emit("click");
assert.equal(elements.get("language").value, "");
elements.get("replyLanguageSearch").value = "missing";
options.renderLanguagePickers();
assert.equal(elements.get("replyLanguageOptions").children[0].textContent, "No matching languages.");
options.renderProfileOptions(null);
options.renderProfileOptions({ voices: "bad", languages: "bad", models: "bad" });
elements.get("replyLanguageSearch").value = "";
options.renderLanguagePickers();
assert.equal(elements.get("replyLanguageOptions").children[0].textContent, "Gateway language catalog unavailable.");
options.renderProfileOptions({
  voices: [{ id: "plain" }],
  languages: [{ code: "zz", label: "", aliases: "bad" }],
  models: [{ id: "plain" }],
});
assert.equal(elements.get("modelOptions").children[0].label, "plain");
assert.equal(elements.get("voiceName").children[1].textContent, "plain");
elements.get("voiceName").value = "plain";
options.renderProfileOptions({ voices: [{ id: "plain" }], languages: [{ code: "zz" }], models: [] });
assert.equal(elements.get("voiceName").value, "plain");

options.renderProfile({
  scope: "device", is_overridden: true,
  profile: { system_prompt: "Prompt", model: "gemini", temperature: 0, voice_max_chars: 100, voice: "chirp", language: "am-ET", input_languages: "en-US" },
});
assert.equal(elements.get("systemPrompt").value, "Prompt");
assert.match(elements.get("profileState").innerHTML, /customized/);
options.renderProfile();
assert.match(elements.get("profileState").innerHTML, /gateway defaults/);

options.renderCompanions({
  active_companion_id: "friend",
  companions: [{ id: "friend", name: "A&B", summary: "<help>", voice: "chirp", tags: ["warm"] }],
});
elements.get("companionList").value = "friend";
options.renderSelectedCompanion("Ready");
assert.match(elements.get("companionDetails").innerHTML, /A&amp;B/);
assert.equal(options.selectedCompanion().id, "friend");
options.renderCompanions({ companions: [] });
assert.equal(options.selectedCompanion(), null);
assert.equal(elements.get("companionDetails").textContent, "No companions loaded.");
options.renderCompanions({ companions: [{ id: "one", name: "One" }] });
elements.get("companionList").value = "missing";
options.renderSelectedCompanion();
assert.equal(elements.get("companionDetails").textContent, "Select a companion.");

globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  if (path === "/v1/agent/profile/options") return { ok: true, status: 200, json: async () => profileOptions };
  if (path === "/v1/agent/profile" && init.method === "PUT") return { ok: true, status: 200, json: async () => ({ profile: JSON.parse(init.body).profile }) };
  if (path === "/v1/agent/profile") return { ok: true, status: 200, json: async () => ({ scope: "global", profile: { model: "gemini" } }) };
  if (path === "/v1/agent/companions" && init.method === "POST") return { ok: true, status: 201, json: async () => ({ companion: { id: "new" } }) };
  if (path === "/v1/agent/companions") return { ok: true, status: 200, json: async () => ({ companions: [{ id: "new", name: "New" }] }) };
  if (path === "/v1/agent/companions/preview") return { ok: true, status: 200, json: async () => ({ profile_preview: { changed: { voice: "new" } } }) };
  if (path === "/v1/agent/companions/apply") return { ok: true, status: 200, json: async () => ({ profile: { active_companion_id: "new" } }) };
  if (path === "/v1/agent/profile/reset") return { ok: true, status: 200, json: async () => ({ profile: {} }) };
  throw new Error(`unexpected ${url}`);
};
elements.get("gatewayUrl").value = "https://gateway.test";
elements.get("companionPrompt").value = "A useful friend";
await options.loadProfile();
assert.match(elements.get("profileState").innerHTML, /gateway defaults/);
await options.loadCompanions("https://gateway.test", "token", "new");
elements.get("companionList").value = "new";
await options.createCompanionFromPrompt();
elements.get("companionList").value = "new";
assert.equal((await options.previewSelectedCompanion()).profile_preview.changed.voice, "new");
assert.equal((await options.applySelectedCompanion()).profile.active_companion_id, "new");

elements.get("gatewayUrl").value = "";
await options.loadProfile();
assert.match(elements.get("profileState").textContent, /Set the gateway URL/);
await assert.rejects(options.createCompanionFromPrompt(), /gateway URL/);
await assert.rejects(options.previewSelectedCompanion(), /gateway URL/);
await assert.rejects(options.applySelectedCompanion(), /gateway URL/);
await assert.rejects(options.applyProfilePatch({ model: "x" }), /gateway URL/);
elements.get("gatewayUrl").value = "https://gateway.test";
elements.get("companionPrompt").value = "";
await assert.rejects(options.createCompanionFromPrompt(), /Describe/);
elements.get("companionPrompt").value = "Friend";
elements.get("companionList").value = "missing";
await assert.rejects(options.previewSelectedCompanion(), /Select/);
await assert.rejects(options.applySelectedCompanion(), /Select/);
await assert.rejects(options.applyProfilePatch({}), /Nothing/);

elements.get("companionList").value = "one";
options.renderCompanions({ companions: [{ id: "one", name: "One" }] });
elements.get("companionList").value = "one";
elements.get("profileScope").value = "global";
for (const [operation, status, message] of [
  [options.createCompanionFromPrompt, 401, /token/],
  [options.createCompanionFromPrompt, 500, /500/],
  [options.previewSelectedCompanion, 500, /500/],
  [options.applySelectedCompanion, 401, /token/],
  [options.applySelectedCompanion, 500, /500/],
  [() => options.applyProfilePatch({ model: "x" }, { scope: "device" }), 401, /token/],
  [() => options.applyProfilePatch({ model: "x" }), 500, /500/],
]) {
  elements.get("companionPrompt").value = "Friend";
  globalThis.fetch = async () => ({ ok: false, status });
  await assert.rejects(operation(), message);
}
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  if (path === "/v1/agent/companions/preview") return { ok: true, status: 200, json: async () => ({ profile_preview: {} }) };
  throw new Error(`unexpected ${url}`);
};
assert.deepEqual(await options.previewSelectedCompanion(), { profile_preview: {} });

let profileStatus = 200;
let optionStatus = 200;
let companionsStatus = 200;
let throwPath = "";
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  if (path === throwPath) throw new Error("network down");
  if (path === "/v1/agent/profile/options") return { ok: optionStatus < 400, status: optionStatus, json: async () => profileOptions };
  if (path === "/v1/agent/profile") return { ok: profileStatus < 400, status: profileStatus, json: async () => ({ profile: { model: "loaded" } }) };
  if (path === "/v1/agent/companions") return { ok: companionsStatus < 400, status: companionsStatus, json: async () => ({ companions: [] }) };
  throw new Error(`unexpected ${url}`);
};
profileStatus = 401;
await options.loadProfile();
assert.match(elements.get("profileStatus").textContent, /401/);
profileStatus = 503;
await options.loadProfile();
assert.match(elements.get("profileStatus").textContent, /503/);
profileStatus = 200;
optionStatus = 503;
await options.loadProfileOptions("https://gateway.test", "token");
assert.match(elements.get("profileCatalogState").textContent, /503/);
optionStatus = 200;
throwPath = "/v1/agent/profile/options";
await options.loadProfileOptions("https://gateway.test", "token");
assert.match(elements.get("profileCatalogState").textContent, /using last loaded/);
throwPath = "";
companionsStatus = 503;
await options.loadCompanions("https://gateway.test", "token");
assert.match(elements.get("companionStatus").textContent, /503/);
companionsStatus = 200;
throwPath = "/v1/agent/companions";
await options.loadCompanions("https://gateway.test", "token");
assert.match(elements.get("companionStatus").textContent, /network down/);
await options.loadCompanions("", "token");
throwPath = "/v1/agent/profile";
delete stored.ageeProfileCache;
await options.loadProfile();
assert.match(elements.get("profileStatus").textContent, /Could not reach/);
stored.ageeProfileCache = { profile: { model: "cached" } };
await options.loadProfile();
assert.equal(elements.get("profileModel").value, "cached");
throwPath = "";

elements.get("systemPrompt").value = " System ";
elements.get("profileModel").value = " gemini ";
elements.get("temperature").value = "0.2";
elements.get("voiceMaxChars").value = "200";
elements.get("voiceName").value = "chirp";
elements.get("language").value = "am-ET";
elements.get("inputLanguages").value = "en-US,am-ET";
assert.deepEqual(options.patchFromForm(), {
  system_prompt: "System", model: "gemini", temperature: 0.2, voice_max_chars: 200,
  voice: "chirp", language: "am-ET", language_mode: "explicit",
  language_output: "primary_only", input_languages: "en-US,am-ET",
});
await options.applyProfilePatch({ model: "gemini" });

elements.get("changeBox").value = "set temperature to 0.3";
await options.applyTalk(elements.get("changeBox").value);
assert.match(elements.get("talkResult").textContent, /Applied/);
await options.applyTalk("this is not a setting");
assert.match(elements.get("talkResult").textContent, /Could not/);
elements.get("gatewayUrl").value = "";
await options.applyTalk("set temperature to 0.4");
assert.match(elements.get("talkResult").textContent, /gateway URL/);
elements.get("gatewayUrl").value = "https://gateway.test";

globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  if (path === "/v1/agent/profile/reset") return { ok: true, status: 200, json: async () => ({ profile: {} }) };
  if (path === "/v1/agent/profile/options") return { ok: true, status: 200, json: async () => profileOptions };
  if (path === "/v1/agent/companions") return { ok: true, status: 200, json: async () => ({ companions: [] }) };
  if (path === "/v1/agent/profile" && init.method === "PUT") return { ok: true, status: 200, json: async () => ({ profile: JSON.parse(init.body).profile }) };
  if (path === "/v1/agent/profile") return { ok: true, status: 200, json: async () => ({ profile: {} }) };
  throw new Error(`unexpected ${url}`);
};
await elements.get("resetProfile").emit("click");
assert.match(elements.get("profileStatus").textContent, /defaults/);
await elements.get("searchCompanions").emit("click");
await elements.get("companionSearch").emit("keydown", { key: "Enter" });
await elements.get("refreshProfile").emit("click");
await elements.get("saveProfile").emit("click");
elements.get("gatewayUrl").value = "";
await elements.get("saveProfile").emit("click");
assert.match(elements.get("profileStatus").textContent, /gateway URL/);
await elements.get("createCompanion").emit("click");
await elements.get("previewCompanion").emit("click");
await elements.get("applyCompanion").emit("click");
await elements.get("resetProfile").emit("click");
assert.match(elements.get("profileStatus").textContent, /gateway URL/);
await elements.get("changeBox").emit("keydown", { key: "Escape" });
await elements.get("changeBox").emit("keydown", { key: "Enter" });

storageListener({}, "sync");
storageListener({ ageeProfileCache: { newValue: { profile: { model: "ignored" } } } }, "sync");
storageListener({ ageeProfileCache: { newValue: { profile: { model: "live" } } } }, "local");
assert.equal(elements.get("profileModel").value, "live");

stored.ageeGatewayUrl = "";
stored.ageeGatewayToken = "";
stored.ageeGatewayUserSet = true;
const optionalIds = new Set([
  "livekitVoice", "livekitVoiceStatus", "voiceFirstGestures", "voiceFirstGesturesStatus",
  "backgroundAutomation", "backgroundAutomationStatus", "modelOptions", "voiceName",
  "languageOptions", "replyLanguageSelected", "replyLanguageSearch", "replyLanguageOptions",
  "heardLanguageSelected", "heardLanguageSearch", "heardLanguageOptions", "profileCatalogState",
  "companionSearch", "companionList", "companionDetails", "companionPrompt", "companionStatus",
  "searchCompanions", "createCompanion", "previewCompanion", "applyCompanion",
]);
globalThis.document = {
  getElementById(id) { return optionalIds.has(id) ? null : elements.get(id) || null; },
  createElement: document.createElement,
};
globalThis.fetch = async () => ({ ok: false, status: 404 });
const sparseOptions = await import(`../extension/options.js?sparse=${Date.now()}`);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(sparseOptions.languagePickerConfigs(), []);
await sparseOptions.loadCompanions("https://gateway.test", "token");
sparseOptions.renderSelectedCompanion();
assert.equal(sparseOptions.selectedCompanion(), null);
globalThis.fetch = async () => { throw "offline"; };
await sparseOptions.loadProfileOptions("https://gateway.test", "token");

globalThis.chrome = original.chrome;
globalThis.document = original.document;
globalThis.fetch = original.fetch;
if (original.navigatorDescriptor) Object.defineProperty(globalThis, "navigator", original.navigatorDescriptor);
else delete globalThis.navigator;
globalThis.setTimeout = original.setTimeout;

console.log("options runtime tests passed");
