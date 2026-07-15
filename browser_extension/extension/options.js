import { DEFAULT_GATEWAY_URL, gatewayUrlDiagnostic, getEffectiveGatewayConfig, normalizeGatewayUrl } from "./config.js";
import { parseSettingsIntent, PROFILE_FIELDS } from "./settings-intent.js";

const gatewayUrlEl = document.getElementById("gatewayUrl");
const gatewayTokenEl = document.getElementById("gatewayToken");
const statusEl = document.getElementById("status");
const micStatusEl = document.getElementById("micStatus");

// Runtime agent profile surface.
const profileStateEl = document.getElementById("profileState");
const changeBoxEl = document.getElementById("changeBox");
const talkResultEl = document.getElementById("talkResult");
const profileScopeEl = document.getElementById("profileScope");
const systemPromptEl = document.getElementById("systemPrompt");
const profileModelEl = document.getElementById("profileModel");
const modelOptionsEl = document.getElementById("modelOptions");
const temperatureEl = document.getElementById("temperature");
const voiceMaxCharsEl = document.getElementById("voiceMaxChars");
const voiceNameEl = document.getElementById("voiceName");
const languageEl = document.getElementById("language");
const inputLanguagesEl = document.getElementById("inputLanguages");
const languageOptionsEl = document.getElementById("languageOptions");
const replyLanguageSelectedEl = document.getElementById("replyLanguageSelected");
const replyLanguageSearchEl = document.getElementById("replyLanguageSearch");
const replyLanguageOptionsEl = document.getElementById("replyLanguageOptions");
const heardLanguageSelectedEl = document.getElementById("heardLanguageSelected");
const heardLanguageSearchEl = document.getElementById("heardLanguageSearch");
const heardLanguageOptionsEl = document.getElementById("heardLanguageOptions");
const profileCatalogStateEl = document.getElementById("profileCatalogState");
const profileStatusEl = document.getElementById("profileStatus");
const companionSearchEl = document.getElementById("companionSearch");
const companionListEl = document.getElementById("companionList");
const companionDetailsEl = document.getElementById("companionDetails");
const companionPromptEl = document.getElementById("companionPrompt");
const companionStatusEl = document.getElementById("companionStatus");

// Cache key written by both this page and background.js after a successful PUT,
// so a profile change applied from the overlay refreshes this page live.
const PROFILE_CACHE_KEY = "ageeProfileCache";

chrome.storage.local
  .get(["ageeGatewayUrl", "ageeGatewayUserSet"])
  .then(async (stored) => ({ stored, ...(await getEffectiveGatewayConfig()) }))
  .then(({ stored, gatewayUrl, gatewayToken }) => {
    gatewayUrlEl.value = stored.ageeGatewayUserSet === true ? gatewayUrl : (gatewayUrl || DEFAULT_GATEWAY_URL);
    if (gatewayToken) gatewayTokenEl.value = gatewayToken;
    if (gatewayUrl) loadProfile();
  });

// Experimental LiveKit voice flag (off by default). Stored in chrome.storage.local
// and read by background.js at voice start; when off, browser voice stays on the
// default WebSocket path.
const LIVEKIT_VOICE_FLAG_KEY = "ageeLivekitVoiceEnabled";
const livekitVoiceEl = document.getElementById("livekitVoice");
const livekitVoiceStatusEl = document.getElementById("livekitVoiceStatus");
if (livekitVoiceEl) {
  chrome.storage.local.get({ [LIVEKIT_VOICE_FLAG_KEY]: false }).then((stored) => {
    livekitVoiceEl.checked = stored[LIVEKIT_VOICE_FLAG_KEY] === true;
  });
  livekitVoiceEl.addEventListener("change", async () => {
    await chrome.storage.local.set({ [LIVEKIT_VOICE_FLAG_KEY]: livekitVoiceEl.checked === true });
    if (livekitVoiceStatusEl) {
      livekitVoiceStatusEl.textContent = livekitVoiceEl.checked ? "On (experimental)" : "Off";
      livekitVoiceStatusEl.style.color = "#777";
    }
  });
}

// Experimental voice-first mark gestures flag (off by default). Read live by
// content.js: single click = current-thread capture toggle, hold = push-to-talk,
// double-click = fresh-thread capture toggle, triple-click = chat. Off keeps the
// legacy gesture map.
const VOICE_FIRST_GESTURES_KEY = "ageeVoiceFirstGesturesEnabled";
const voiceFirstGesturesEl = document.getElementById("voiceFirstGestures");
const voiceFirstGesturesStatusEl = document.getElementById("voiceFirstGesturesStatus");
if (voiceFirstGesturesEl) {
  chrome.storage.local.get({ [VOICE_FIRST_GESTURES_KEY]: false }).then((stored) => {
    voiceFirstGesturesEl.checked = stored[VOICE_FIRST_GESTURES_KEY] === true;
  });
  voiceFirstGesturesEl.addEventListener("change", async () => {
    await chrome.storage.local.set({ [VOICE_FIRST_GESTURES_KEY]: voiceFirstGesturesEl.checked === true });
    if (voiceFirstGesturesStatusEl) {
      voiceFirstGesturesStatusEl.textContent = voiceFirstGesturesEl.checked ? "On (experimental)" : "Off";
      voiceFirstGesturesStatusEl.style.color = "#777";
    }
  });
}

// Background automation is off by default and version-consented. Read by background.js before it
// claims any gateway-queued browser work: it gates BOTH the legacy
// pollBrowserTasks() batch path and the new pollBrowserAgentTasks() agent-loop.
// When off, the extension claims no background browser tasks at all.
const BACKGROUND_AUTOMATION_KEY = "ageeBackgroundAutomationEnabled";
const BACKGROUND_AUTOMATION_CONSENT_KEY = "ageeBackgroundAutomationConsentVersion";
const BACKGROUND_AUTOMATION_CONSENT_VERSION = 1;
const backgroundAutomationEl = document.getElementById("backgroundAutomation");
const backgroundAutomationStatusEl = document.getElementById("backgroundAutomationStatus");
if (backgroundAutomationEl) {
  chrome.storage.local.get({
    [BACKGROUND_AUTOMATION_KEY]: false,
    [BACKGROUND_AUTOMATION_CONSENT_KEY]: 0,
  }).then((stored) => {
    backgroundAutomationEl.checked =
      stored[BACKGROUND_AUTOMATION_KEY] === true &&
      stored[BACKGROUND_AUTOMATION_CONSENT_KEY] === BACKGROUND_AUTOMATION_CONSENT_VERSION;
    if (backgroundAutomationStatusEl) {
      backgroundAutomationStatusEl.textContent = backgroundAutomationEl.checked ? "On" : "Off";
      backgroundAutomationStatusEl.style.color = "#777";
    }
  });
  backgroundAutomationEl.addEventListener("change", async () => {
    const enabled = backgroundAutomationEl.checked === true;
    await chrome.storage.local.set({
      [BACKGROUND_AUTOMATION_KEY]: enabled,
      [BACKGROUND_AUTOMATION_CONSENT_KEY]: enabled ? BACKGROUND_AUTOMATION_CONSENT_VERSION : 0,
    });
    if (backgroundAutomationStatusEl) {
      backgroundAutomationStatusEl.textContent = backgroundAutomationEl.checked ? "On" : "Off";
      backgroundAutomationStatusEl.style.color = "#777";
    }
  });
}

function flash(text, ok = true) {
  statusEl.textContent = text;
  statusEl.style.color = ok ? "#35a35a" : "#c0392b";
}

function flashProfile(text, ok = true) {
  profileStatusEl.textContent = text;
  profileStatusEl.style.color = ok ? "#35a35a" : "#c0392b";
}

function flashMic(text, ok = true) {
  micStatusEl.textContent = text;
  micStatusEl.style.color = ok ? "#35a35a" : "#c0392b";
}

function flashCompanion(text, ok = true) {
  if (!companionStatusEl) return;
  companionStatusEl.textContent = text;
  companionStatusEl.style.color = ok ? "#35a35a" : "#c0392b";
}

function gatewayConfig() {
  return {
    url: normalizeGatewayUrl(gatewayUrlEl.value),
    token: gatewayTokenEl.value.trim(),
  };
}

function gatewayHeaders(token, withBody) {
  const headers = {};
  if (withBody) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function networkFailureMessage(url, path, error) {
  const detail = String(error?.message || error || "").trim();
  const detailSuffix = detail && detail !== "Failed to fetch" ? ` (${detail})` : "";
  const diagnostic = gatewayUrlDiagnostic(url);
  const diagnosticSuffix = diagnostic.message ? ` ${diagnostic.message}` : "";
  return `Could not reach the configured gateway ${url || "(unset)"} while calling ${path}. Check DNS, TLS, and the saved gateway URL.${diagnosticSuffix}${detailSuffix}`;
}

function parseJsonOrNull(text) {
  if (!String(text || "").trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getStableDeviceId() {
  const { ageeDeviceId } = await chrome.storage.local.get("ageeDeviceId");
  if (ageeDeviceId) return ageeDeviceId;
  const deviceId = `browser_${crypto.randomUUID().replace(/-/g, "")}`;
  await chrome.storage.local.set({ ageeDeviceId: deviceId });
  return deviceId;
}

async function profileQuery() {
  if (profileScopeEl?.value !== "device") {
    return "";
  }
  const deviceId = await getStableDeviceId();
  return `?scope=device&device_id=${encodeURIComponent(deviceId)}`;
}

document.getElementById("save").addEventListener("click", async () => {
  const url = normalizeGatewayUrl(gatewayUrlEl.value);
  if (url) {
    const diagnostic = gatewayUrlDiagnostic(url);
    if (!diagnostic.ok) {
      flash(diagnostic.message, false);
      return;
    }
  }
  const disconnected = !url;
  await chrome.storage.local.set({
    ageeGatewayUrl: url,
    ageeGatewayToken: disconnected ? "" : gatewayTokenEl.value.trim(),
    // Mark the URL as user-owned so seeding stops overwriting it with the
    // baked default on the next startup. A blank user-owned URL is an explicit
    // disconnect, not a request to restore the packaged suggestion.
    ageeGatewayUserSet: true,
  });
  if (disconnected) gatewayTokenEl.value = "";
  flash(disconnected ? "Disconnected ✓" : "Saved ✓");
  setTimeout(() => (statusEl.textContent = ""), 1500);
});

document.getElementById("testGateway").addEventListener("click", async () => {
  const url = normalizeGatewayUrl(gatewayUrlEl.value);
  const diagnostic = gatewayUrlDiagnostic(url);
  if (!diagnostic.ok) {
    flash(diagnostic.message, false);
    return;
  }
  const warning = diagnostic.severity === "warning" ? diagnostic.message : "";
  flash(warning ? `${warning} Testing anyway…` : "Testing…", !warning);
  const token = gatewayTokenEl.value.trim();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let data;
  try {
    const resp = await fetch(`${url}/health`, { headers });
    const text = await resp.text();
    data = parseJsonOrNull(text);
    if (!data) {
      flash(`The URL responded, but it is not a healthy Moa gateway (${url}).`, false);
      return;
    }
    if (!resp.ok || !data.ok) {
      flash(`The URL responded, but it is not a healthy Moa gateway (${resp.status}).`, false);
      return;
    }
  } catch (err) {
    flash(networkFailureMessage(url, "/health", err), false);
    return;
  }

  // /health needs no token. The endpoints the agent actually uses
  // (/v1/voice/turns, /v1/browser/turns) require the gateway token, so probe an
  // authenticated endpoint to confirm the token before reporting success —
  // otherwise a missing/wrong token shows green here but 401s in use.
  const tag = `${data.provider || "provider"} · ${data.model || "model"}`;
  try {
    const authResp = await fetch(`${url}/v1/sessions`, { headers });
    if (authResp.ok) {
      flash(warning ? `OK ✓ ${tag} · token valid. ${warning}` : `OK ✓ ${tag} · token valid`);
    } else if (authResp.status === 401 || authResp.status === 403) {
      if (warning) {
        flash("Gateway reachable, but the token may belong to a different gateway. Confirm the stable VPS URL, then re-register.", false);
      } else {
        flash(
          token
            ? `Gateway reachable, but the saved token was rejected (${authResp.status}). Re-register this browser or paste a fresh token.`
            : `Gateway reachable, but this route requires a device token (${authResp.status}). Add the Gateway token below.`,
          false
        );
      }
    } else {
      flash(`Gateway reachable; auth check returned ${authResp.status}`, false);
    }
  } catch (err) {
    flash(`Gateway reachable; auth check failed. ${networkFailureMessage(url, "/v1/sessions", err)}`, false);
  }
});

async function microphonePermissionState() {
  if (!navigator.permissions?.query) return "unknown";
  try {
    const result = await navigator.permissions.query({ name: "microphone" });
    return result.state || "unknown";
  } catch {
    return "unknown";
  }
}

document.getElementById("grantMic").addEventListener("click", async () => {
  flashMic("Requesting…");
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    flashMic("Microphone granted to A.G. ✓");
  } catch (err) {
    flashMic(`Microphone blocked: ${String(err.message || err)}`, false);
  } finally {
    for (const track of stream?.getTracks?.() || []) {
      try {
        track.stop();
      } catch {}
    }
  }
});

document.getElementById("checkMic").addEventListener("click", async () => {
  const state = await microphonePermissionState();
  if (state === "granted") {
    flashMic("Microphone already granted ✓");
  } else if (state === "denied") {
    flashMic("Microphone blocked. Change site settings for this extension.", false);
  } else {
    flashMic("Microphone not granted yet.");
  }
});

// ---- Runtime agent profile -------------------------------------------------

let currentProfile = null; // last effective profile we rendered
let currentProfileOptions = null;
let languageCatalog = [];
let currentCompanions = [];

function splitLanguageCodes(value) {
  const seen = new Set();
  const codes = [];
  for (const raw of String(value || "").split(",")) {
    const code = raw.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

function languageLabel(code) {
  const match = languageCatalog.find((language) => language.code === code);
  return match ? `${match.label} (${match.code})` : code;
}

function setLanguageCodes(input, codes) {
  input.value = codes.join(",");
}

function languagePickerConfigs() {
  return [
    {
      input: languageEl,
      selected: replyLanguageSelectedEl,
      search: replyLanguageSearchEl,
      options: replyLanguageOptionsEl,
      empty: "No reply languages selected.",
    },
    {
      input: inputLanguagesEl,
      selected: heardLanguageSelectedEl,
      search: heardLanguageSearchEl,
      options: heardLanguageOptionsEl,
      empty: "No heard languages selected.",
    },
  ].filter((config) => config.input && config.selected && config.search && config.options);
}

function renderLanguagePickers() {
  for (const config of languagePickerConfigs()) {
    renderLanguagePicker(config);
  }
}

function renderLanguagePicker(config) {
  const selectedCodes = splitLanguageCodes(config.input.value);
  config.selected.textContent = "";
  if (selectedCodes.length === 0) {
    const empty = document.createElement("span");
    empty.className = "catalog-empty";
    empty.textContent = config.empty;
    config.selected.append(empty);
  } else {
    for (const code of selectedCodes) {
      const pill = document.createElement("span");
      pill.className = "catalog-pill";
      pill.textContent = languageLabel(code);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "x";
      remove.setAttribute("aria-label", `Remove ${languageLabel(code)}`);
      remove.addEventListener("click", () => {
        setLanguageCodes(config.input, selectedCodes.filter((item) => item !== code));
        renderLanguagePicker(config);
      });
      pill.append(remove);
      config.selected.append(pill);
    }
  }

  const query = config.search.value.trim().toLowerCase();
  const matches = languageCatalog
    .filter((language) => {
      if (!query) return true;
      const aliases = Array.isArray(language.aliases) ? language.aliases.join(" ") : "";
      return `${language.label} ${language.code} ${aliases}`.toLowerCase().includes(query);
    })
    .slice(0, 80);

  config.options.textContent = "";
  if (matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "catalog-empty";
    empty.textContent = languageCatalog.length ? "No matching languages." : "Gateway language catalog unavailable.";
    config.options.append(empty);
    return;
  }

  for (const language of matches) {
    const code = String(language.code || "").trim();
    if (!code) continue;
    const row = document.createElement("label");
    row.className = "catalog-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedCodes.includes(code);
    checkbox.addEventListener("change", () => {
      const next = checkbox.checked
        ? [...selectedCodes, code]
        : selectedCodes.filter((item) => item !== code);
      setLanguageCodes(config.input, next);
      renderLanguagePicker(config);
    });
    const text = document.createElement("span");
    text.textContent = String(language.label || code);
    const small = document.createElement("small");
    small.textContent = code;
    row.append(checkbox, text, small);
    config.options.append(row);
  }
}

function renderProfileOptions(payload) {
  if (!payload || typeof payload !== "object") return;
  currentProfileOptions = payload;
  const voices = Array.isArray(payload.voices) ? payload.voices : [];
  const languages = Array.isArray(payload.languages) ? payload.languages : [];
  const models = Array.isArray(payload.models) ? payload.models : [];
  languageCatalog = languages
    .map((language) => ({
      label: String(language.label || language.code || "").trim(),
      code: String(language.code || "").trim(),
      aliases: Array.isArray(language.aliases) ? language.aliases.map((alias) => String(alias || "")) : [],
    }))
    .filter((language) => language.code);
  if (modelOptionsEl) {
    modelOptionsEl.textContent = "";
    for (const model of models) {
      const id = String(model.id || "").trim();
      if (!id) continue;
      const option = document.createElement("option");
      option.value = id;
      option.label = model.provider ? `${id} - ${model.provider}` : id;
      modelOptionsEl.append(option);
    }
  }
  if (voiceNameEl) {
    const selected = voiceNameEl.value || currentProfile?.voice || "";
    voiceNameEl.textContent = "";
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Gateway default";
    voiceNameEl.append(defaultOption);
    for (const voice of voices) {
      const id = String(voice.id || "").trim();
      if (!id) continue;
      const option = document.createElement("option");
      option.value = id;
      const tags = Array.isArray(voice.tone_tags) ? voice.tone_tags.join(", ") : "";
      option.textContent = tags ? `${id} - ${tags}` : id;
      voiceNameEl.append(option);
    }
    if (selected && voices.some((voice) => voice.id === selected)) {
      voiceNameEl.value = selected;
    }
  }
  if (languageOptionsEl) {
    languageOptionsEl.textContent = "";
    for (const language of languageCatalog) {
      const option = document.createElement("option");
      option.value = language.code;
      option.label = language.label || language.code;
      languageOptionsEl.append(option);
    }
  }
  renderLanguagePickers();
  if (profileCatalogStateEl) {
    profileCatalogStateEl.textContent = `Loaded ${voices.length} voices, ${languageCatalog.length} languages, and ${models.length} model options from the gateway catalog.`;
  }
}

function renderProfile(payload) {
  const profile = payload?.profile || {};
  currentProfile = profile;
  systemPromptEl.value = profile.system_prompt || "";
  profileModelEl.value = profile.model || "";
  temperatureEl.value = profile.temperature ?? "";
  voiceMaxCharsEl.value = profile.voice_max_chars ?? "";
  if (voiceNameEl) voiceNameEl.value = profile.voice || "";
  languageEl.value = profile.language || profile.language_primary || "";
  if (inputLanguagesEl) inputLanguagesEl.value = profile.input_languages || profile.input_language_primary || "";
  renderLanguagePickers();
  const overridden = Boolean(payload?.is_overridden);
  profileStateEl.innerHTML =
    `In effect ${payload?.scope === "device" ? "on this device" : "on the gateway"}: <span class="badge ${overridden ? "overridden" : ""}">` +
    `${overridden ? "customized" : "gateway defaults"}</span>`;
}

// Read the effective profile from the gateway (GET /v1/agent/profile) and show
// what is in effect. Falls back to the cached copy if the gateway is offline.
async function loadProfile() {
  const { url, token } = gatewayConfig();
  if (!url) {
    profileStateEl.textContent = "Set the gateway URL above to load the runtime profile.";
    return;
  }
  flashProfile("Loading…");
  try {
    await loadProfileOptions(url, token);
    const resp = await fetch(`${url}/v1/agent/profile${await profileQuery()}`, { headers: gatewayHeaders(token, false) });
    if (resp.status === 401) {
      profileStateEl.textContent = "Gateway requires a token to read the profile. Add the Gateway token and Save.";
      flashProfile("401 — token required", false);
      return;
    }
    if (!resp.ok) {
      flashProfile(`Gateway returned ${resp.status}`, false);
      return;
    }
    const payload = await resp.json();
    renderProfile(payload);
    await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: payload });
    await loadCompanions(url, token);
    flashProfile("Loaded ✓");
    setTimeout(() => (profileStatusEl.textContent = ""), 1200);
  } catch (err) {
    const cached = (await chrome.storage.local.get(PROFILE_CACHE_KEY))[PROFILE_CACHE_KEY];
    if (cached) {
      renderProfile(cached);
      flashProfile(`Gateway offline; showing last known profile`, false);
    } else {
      flashProfile(networkFailureMessage(url, "/v1/agent/profile", err), false);
    }
  }
}

async function loadProfileOptions(url, token) {
  try {
    const resp = await fetch(`${url}/v1/agent/profile/options`, { headers: gatewayHeaders(token, false) });
    if (!resp.ok) {
      if (profileCatalogStateEl) {
        profileCatalogStateEl.textContent = `Gateway options catalog unavailable (${resp.status}).`;
      }
      return;
    }
    renderProfileOptions(await resp.json());
  } catch {
    if (profileCatalogStateEl) {
      profileCatalogStateEl.textContent = currentProfileOptions
        ? "Gateway options catalog offline; using last loaded options."
        : "Gateway options catalog unavailable.";
    }
  }
}

async function loadCompanions(url, token, query = companionSearchEl?.value || "") {
  if (!url || !companionListEl) return;
  try {
    const q = String(query || "").trim();
    const resp = await fetch(`${url}/v1/agent/companions${q ? `?q=${encodeURIComponent(q)}` : ""}`, {
      headers: gatewayHeaders(token, false),
    });
    if (!resp.ok) {
      flashCompanion(`Catalog ${resp.status}`, false);
      return;
    }
    const payload = await resp.json();
    renderCompanions(payload);
    flashCompanion(`Loaded ${currentCompanions.length} companions ✓`);
    setTimeout(() => (companionStatusEl.textContent = ""), 1400);
  } catch (err) {
    flashCompanion(`Catalog unavailable: ${String(err.message || err)}`, false);
  }
}

function renderCompanions(payload) {
  currentCompanions = Array.isArray(payload?.companions) ? payload.companions : [];
  companionListEl.textContent = "";
  for (const item of currentCompanions) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.name} — ${item.summary || item.voice || ""}`.slice(0, 180);
    companionListEl.append(option);
  }
  const activeId = currentProfile?.active_companion_id || payload?.active_companion_id || "";
  if (activeId && currentCompanions.some((item) => item.id === activeId)) {
    companionListEl.value = activeId;
  }
  renderSelectedCompanion();
}

function selectedCompanion() {
  const id = companionListEl?.value || "";
  return currentCompanions.find((item) => item.id === id) || null;
}

function renderSelectedCompanion(extra = "") {
  if (!companionDetailsEl) return;
  const item = selectedCompanion();
  if (!item) {
    companionDetailsEl.textContent = currentCompanions.length ? "Select a companion." : "No companions loaded.";
    return;
  }
  const tags = Array.isArray(item.tags) && item.tags.length ? ` · ${item.tags.join(", ")}` : "";
  const active = currentProfile?.active_companion_id === item.id ? "Active · " : "";
  companionDetailsEl.innerHTML =
    `<strong>${active}${escapeHtml(item.name)}</strong>` +
    `${escapeHtml(item.summary || "")}<br>` +
    `Voice: ${escapeHtml(item.voice || "default")}${escapeHtml(tags)}${extra ? `<br>${escapeHtml(extra)}` : ""}`;
}

async function createCompanionFromPrompt() {
  const { url, token } = gatewayConfig();
  const text = companionPromptEl?.value.trim();
  if (!url) throw new Error("Set the gateway URL first.");
  if (!text) throw new Error("Describe the companion first.");
  const resp = await fetch(`${url}/v1/agent/companions`, {
    method: "POST",
    headers: gatewayHeaders(token, true),
    body: JSON.stringify({ text, source: "agee-options" }),
  });
  if (resp.status === 401) throw new Error("Gateway rejected the token (401).");
  if (!resp.ok) throw new Error(`Gateway returned ${resp.status}`);
  const payload = await resp.json();
  companionPromptEl.value = "";
  await loadCompanions(url, token);
  if (payload?.companion?.id && currentCompanions.some((item) => item.id === payload.companion.id)) {
    companionListEl.value = payload.companion.id;
  }
  renderSelectedCompanion("Draft created. Preview or apply it when ready.");
  return payload;
}

async function previewSelectedCompanion() {
  const { url, token } = gatewayConfig();
  const item = selectedCompanion();
  if (!url) throw new Error("Set the gateway URL first.");
  if (!item) throw new Error("Select a companion first.");
  const resp = await fetch(`${url}/v1/agent/companions/preview`, {
    method: "POST",
    headers: gatewayHeaders(token, true),
    body: JSON.stringify({
      companion_id: item.id,
      scope: profileScopeEl?.value === "device" ? "device" : "global",
      device_id: await getStableDeviceId(),
    }),
  });
  if (!resp.ok) throw new Error(`Gateway returned ${resp.status}`);
  const payload = await resp.json();
  const changed = payload?.profile_preview?.changed || {};
  const changedFields = Object.keys(changed);
  renderSelectedCompanion(changedFields.length ? `Preview changes: ${changedFields.join(", ")}.` : "Preview has no profile changes.");
  return payload;
}

async function applySelectedCompanion() {
  const { url, token } = gatewayConfig();
  const item = selectedCompanion();
  if (!url) throw new Error("Set the gateway URL first.");
  if (!item) throw new Error("Select a companion first.");
  const resp = await fetch(`${url}/v1/agent/companions/apply`, {
    method: "POST",
    headers: gatewayHeaders(token, true),
    body: JSON.stringify({
      companion_id: item.id,
      scope: profileScopeEl?.value === "device" ? "device" : "global",
      device_id: await getStableDeviceId(),
      source: "agee-options",
    }),
  });
  if (resp.status === 401) throw new Error("Gateway rejected the token (401).");
  if (!resp.ok) throw new Error(`Gateway returned ${resp.status}`);
  const payload = await resp.json();
  renderProfile(payload);
  await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: payload });
  renderSelectedCompanion("Applied to the runtime profile.");
  return payload;
}

// Patch + persist a profile change through the gateway, then re-render from the
// gateway's authoritative response. Shared by the form save and the talk path.
async function applyProfilePatch(patch, options = {}) {
  const { url, token } = gatewayConfig();
  if (!url) throw new Error("Set the gateway URL first.");
  if (!patch || Object.keys(patch).length === 0) throw new Error("Nothing to change.");
  const scope = options.scope === "device" ? "device" : (profileScopeEl?.value === "device" ? "device" : "global");
  const deviceId = await getStableDeviceId();
  const resp = await fetch(`${url}/v1/agent/profile`, {
    method: "PUT",
    headers: gatewayHeaders(token, true),
    body: JSON.stringify({ profile: patch, scope, device_id: deviceId, source: "agee-options" }),
  });
  if (resp.status === 401) throw new Error("Gateway rejected the token (401).");
  if (!resp.ok) throw new Error(`Gateway returned ${resp.status}`);
  const payload = await resp.json();
  renderProfile(payload);
  await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: payload });
  return payload;
}

function patchFromForm() {
  const patch = {};
  const sys = systemPromptEl.value.trim();
  if (sys) patch.system_prompt = sys;
  const model = profileModelEl.value.trim();
  if (model) patch.model = model;
  if (temperatureEl.value !== "") patch.temperature = Number(temperatureEl.value);
  if (voiceMaxCharsEl.value !== "") patch.voice_max_chars = Number(voiceMaxCharsEl.value);
  const voice = voiceNameEl?.value.trim();
  if (voice) patch.voice = voice;
  const lang = languageEl.value.trim();
  if (lang) {
    patch.language = lang;
    patch.language_mode = "explicit";
    patch.language_output = "primary_only";
  }
  const inputLanguages = inputLanguagesEl?.value.trim();
  if (inputLanguages) {
    patch.input_languages = inputLanguages;
  }
  return patch;
}

document.getElementById("saveProfile").addEventListener("click", async () => {
  flashProfile("Saving…");
  try {
    await applyProfilePatch(patchFromForm());
    flashProfile("Saved to gateway ✓");
    setTimeout(() => (profileStatusEl.textContent = ""), 1500);
  } catch (err) {
    flashProfile(String(err.message || err), false);
  }
});

document.getElementById("refreshProfile").addEventListener("click", loadProfile);
profileScopeEl?.addEventListener("change", loadProfile);
for (const config of languagePickerConfigs()) {
  config.search.addEventListener("input", () => renderLanguagePicker(config));
}
companionListEl?.addEventListener("change", () => renderSelectedCompanion());
document.getElementById("searchCompanions")?.addEventListener("click", async () => {
  const { url, token } = gatewayConfig();
  flashCompanion("Searching…");
  await loadCompanions(url, token, companionSearchEl?.value || "");
});
companionSearchEl?.addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    const { url, token } = gatewayConfig();
    flashCompanion("Searching…");
    await loadCompanions(url, token, companionSearchEl.value);
  }
});
document.getElementById("createCompanion")?.addEventListener("click", async () => {
  flashCompanion("Creating…");
  try {
    await createCompanionFromPrompt();
    flashCompanion("Draft created ✓");
  } catch (err) {
    flashCompanion(String(err.message || err), false);
  }
});
document.getElementById("previewCompanion")?.addEventListener("click", async () => {
  flashCompanion("Previewing…");
  try {
    await previewSelectedCompanion();
    flashCompanion("Preview ready ✓");
  } catch (err) {
    flashCompanion(String(err.message || err), false);
  }
});
document.getElementById("applyCompanion")?.addEventListener("click", async () => {
  flashCompanion("Applying…");
  try {
    await applySelectedCompanion();
    flashCompanion("Companion applied ✓");
  } catch (err) {
    flashCompanion(String(err.message || err), false);
  }
});

document.getElementById("resetProfile").addEventListener("click", async () => {
  const { url, token } = gatewayConfig();
  if (!url) {
    flashProfile("Set the gateway URL first.", false);
    return;
  }
  flashProfile("Resetting…");
  try {
    const resp = await fetch(`${url}/v1/agent/profile/reset`, {
      method: "POST",
      headers: gatewayHeaders(token, true),
      body: JSON.stringify({
        scope: profileScopeEl?.value === "device" ? "device" : "global",
        device_id: await getStableDeviceId(),
        source: "agee-options",
      }),
    });
    if (!resp.ok) throw new Error(`Gateway returned ${resp.status}`);
    const payload = await resp.json();
    renderProfile(payload);
    await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: payload });
    flashProfile("Reset to defaults ✓");
    setTimeout(() => (profileStatusEl.textContent = ""), 1500);
  } catch (err) {
    flashProfile(String(err.message || err), false);
  }
});

// Change a setting by talking to the agent: parse plain language into a concrete
// profile patch and apply it through the gateway. The surface re-renders from
// the gateway's response, so the spoken change appears immediately.
async function applyTalk(text) {
  talkResultEl.classList.remove("err");
  const intent = parseSettingsIntent(text, currentProfile);
  if (!intent) {
    talkResultEl.classList.add("err");
    talkResultEl.textContent =
      `Could not turn that into a settings change. Try: "be terser", "set the system prompt to …", ` +
      `"use model gpt-4o-mini", "set temperature to 0.2", "reply in Amharic".`;
    return;
  }
  talkResultEl.textContent = "Applying…";
  try {
    await applyProfilePatch(intent.patch, { scope: intent.scope });
    changeBoxEl.value = "";
    talkResultEl.textContent = `Applied: ${intent.summary}.`;
  } catch (err) {
    talkResultEl.classList.add("err");
    talkResultEl.textContent = String(err.message || err);
  }
}

document.getElementById("applyChange").addEventListener("click", () => applyTalk(changeBoxEl.value.trim()));
changeBoxEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyTalk(changeBoxEl.value.trim());
  }
});

// Live refresh: when a profile change is applied elsewhere (e.g. spoken to the
// agent through the on-page overlay), background.js updates the cached profile.
// Re-render so this open surface stays in sync without a manual reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[PROFILE_CACHE_KEY]) return;
  const next = changes[PROFILE_CACHE_KEY].newValue;
  if (next && next.profile) {
    renderProfile(next);
    renderSelectedCompanion();
    flashProfile("Updated live ✓");
    setTimeout(() => (profileStatusEl.textContent = ""), 1500);
  }
});

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export {
  PROFILE_FIELDS,
  applyProfilePatch,
  applySelectedCompanion,
  applyTalk,
  createCompanionFromPrompt,
  escapeHtml,
  gatewayConfig,
  gatewayHeaders,
  getStableDeviceId,
  languageLabel,
  languagePickerConfigs,
  loadCompanions,
  loadProfile,
  loadProfileOptions,
  microphonePermissionState,
  networkFailureMessage,
  parseJsonOrNull,
  patchFromForm,
  previewSelectedCompanion,
  profileQuery,
  renderCompanions,
  renderLanguagePicker,
  renderLanguagePickers,
  renderProfile,
  renderProfileOptions,
  renderSelectedCompanion,
  selectedCompanion,
  setLanguageCodes,
  splitLanguageCodes,
};
