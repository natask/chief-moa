import { getEffectiveGatewayConfig, normalizeGatewayUrl, seedGatewayConfig } from "./config.js";
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
const temperatureEl = document.getElementById("temperature");
const voiceMaxCharsEl = document.getElementById("voiceMaxChars");
const voiceNameEl = document.getElementById("voiceName");
const languageEl = document.getElementById("language");
const inputLanguagesEl = document.getElementById("inputLanguages");
const profileStatusEl = document.getElementById("profileStatus");

// Cache key written by both this page and background.js after a successful PUT,
// so a profile change applied from the overlay refreshes this page live.
const PROFILE_CACHE_KEY = "ageeProfileCache";

chrome.storage.local
  .get(["ageeGatewayUrl"])
  .then(async () => {
    await seedGatewayConfig();
    return getEffectiveGatewayConfig();
  })
  .then(({ gatewayUrl, gatewayToken }) => {
    if (gatewayUrl) gatewayUrlEl.value = gatewayUrl;
    if (gatewayToken) gatewayTokenEl.value = gatewayToken;
    loadProfile();
  });

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
  await chrome.storage.local.set({
    ageeGatewayUrl: normalizeGatewayUrl(gatewayUrlEl.value),
    ageeGatewayToken: gatewayTokenEl.value.trim(),
  });
  flash("Saved ✓");
  setTimeout(() => (statusEl.textContent = ""), 1500);
});

document.getElementById("testGateway").addEventListener("click", async () => {
  const url = normalizeGatewayUrl(gatewayUrlEl.value);
  if (!url) {
    flash("Enter a gateway URL first.", false);
    return;
  }
  flash("Testing…");
  const token = gatewayTokenEl.value.trim();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let data;
  try {
    const resp = await fetch(`${url}/health`, { headers });
    data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      flash(`Gateway responded ${resp.status}`, false);
      return;
    }
  } catch (err) {
    flash(`Unreachable: ${String(err.message || err)}`, false);
    return;
  }

  // /health needs no token. The endpoints the agent actually uses
  // (/v1/voice/turns, /v1/chat) require the gateway token, so probe an
  // authenticated endpoint to confirm the token before reporting success —
  // otherwise a missing/wrong token shows green here but 401s in use.
  const tag = `${data.provider || "provider"} · ${data.model || "model"}`;
  try {
    const authResp = await fetch(`${url}/v1/sessions`, { headers });
    if (authResp.ok) {
      flash(`OK ✓ ${tag} · token valid`);
    } else if (authResp.status === 401) {
      flash(
        token
          ? "Gateway reachable, but token rejected (401). Check the Gateway token."
          : "Gateway reachable, but it requires a token. Add the Gateway token below.",
        false
      );
    } else {
      flash(`Gateway reachable; auth check returned ${authResp.status}`, false);
    }
  } catch (err) {
    flash(`Gateway reachable; auth check failed: ${String(err.message || err)}`, false);
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
    flashMic("Microphone granted to Aggie ✓");
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

function renderProfile(payload) {
  const profile = payload?.profile || {};
  currentProfile = profile;
  systemPromptEl.value = profile.system_prompt || "";
  profileModelEl.value = profile.model || "";
  temperatureEl.value = profile.temperature ?? "";
  voiceMaxCharsEl.value = profile.voice_max_chars ?? "";
  if (voiceNameEl) voiceNameEl.value = profile.voice || "";
  languageEl.value = profile.language || "";
  if (inputLanguagesEl) inputLanguagesEl.value = profile.input_languages || "";
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
    flashProfile("Loaded ✓");
    setTimeout(() => (profileStatusEl.textContent = ""), 1200);
  } catch (err) {
    const cached = (await chrome.storage.local.get(PROFILE_CACHE_KEY))[PROFILE_CACHE_KEY];
    if (cached) {
      renderProfile(cached);
      flashProfile(`Gateway offline; showing last known profile`, false);
    } else {
      flashProfile(`Unreachable: ${String(err.message || err)}`, false);
    }
  }
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
    patch.language_primary = lang.split(",")[0].trim();
    patch.language_mode = "explicit";
    patch.language_output = "primary_only";
  }
  const inputLanguages = inputLanguagesEl?.value.trim();
  if (inputLanguages) {
    patch.input_languages = inputLanguages;
    patch.input_language_primary = inputLanguages.split(",")[0].trim();
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
      `"use model gpt-4o-mini", "set temperature to 0.2", "reply in Spanish".`;
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
    flashProfile("Updated live ✓");
    setTimeout(() => (profileStatusEl.textContent = ""), 1500);
  }
});

export { PROFILE_FIELDS };
