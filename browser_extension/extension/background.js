// agee — background service worker.
// Thin client: every turn is routed to the user's self-hosted gateway. No
// provider API keys and no direct model calls live in the browser; the gateway
// owns model routing and credentials.

import { DEFAULT_GATEWAY_URL, gatewayUrlDiagnostic, getEffectiveGatewayConfig } from "./config.js";
import { parseSettingsIntent, parseProfileQueryIntent, looksLikeGatewayProfileControlIntent } from "./settings-intent.js";
import { parseBrowserTaskIntent, parseOpenTabIntent, looksLikePageContextQuestion } from "./browser-task-intent.js";
import { isStopCommand } from "./stop-intent.js";
import { isLivekitVoiceEnabled, startLivekitVoiceSession } from "./livekit-voice.js";
import { parseVoiceSamplerAction } from "./voice-sampler.js";
import { createVoiceSamplerRuntime } from "./voice-sampler-runtime.js";
import { browserContextDescriptor, browserSessionExecutionAdapters } from "./browser-context-adapter.js";
import { browserDelegationEnvelope, normalizeBrowserAgentRole } from "./browser-agent-role-runtime.js";
import {
  AGENT_LOOP_MAX_SUMMARY,
  buildAgentLoopObservationPayload,
  clampAgentLoopMaxSteps,
  validateAgentLoopAction,
} from "./browser-agent-loop-policy.js";
import {
  browserEvidencePage,
  browserInlineEvidence,
  browserTurnActions,
  browserTurnClient,
  browserTurnEvidenceRequestId,
  browserTurnFailed,
  browserTurnId,
  browserTurnIsPending,
  browserTurnNeedsEvidence,
  browserTurnReplyText,
  browserTurnStatusPath,
  browserTurnSummary,
  normalizeBrowserSnapshot,
} from "./browser-turn-protocol.js";

chrome.runtime.onInstalled.addListener(async () => {
  await initializePrivacyState();
  await ensureContentOnOpenTabs();
});
chrome.runtime.onStartup.addListener(() => {
  initializePrivacyState().then(() => ensureContentOnOpenTabs()).catch(() => {});
});
const MAX_ELEMENTS = 100;
const ALLOWED_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
// Cues run concurrently: the user keeps talking, each utterance is its own lane.
// Keyed by cueId (a per-cue string), each value is { controller, tabId } so we
// can cancel one cue or all cues on a tab without blocking new ones.
const tasks = new Map();
const voiceSessions = new Map();
const MAX_PENDING_VOICE_EVENTS = 50;
const MAX_QUEUED_VOICE_AUDIO_BYTES = 16000 * 2 * 20;
// Record mode buffers raw PCM16 in the worker until the user stops; cap the
// buffer at ~5 minutes of 16 kHz mono PCM16 and stop capture at the cap.
const recordSessions = new Map();
const RECORD_MAX_AUDIO_BYTES = 16000 * 2 * 300;
// Video notes: one active screen+mic recording at a time. Caps keep the WebM
// under the gateway's inline-video limit (the blob becomes one Gemini part).
let videoNoteSession = null;
const VIDEO_NOTE_MAX_MS = 120_000;
const VIDEO_NOTE_MAX_BYTES = 20 * 1024 * 1024;
const OFFSCREEN_VOICE_DOCUMENT = "offscreen.html";
const ACTIVE_BROWSER_AGENT_OWNER_KEY = "ageeActiveBrowserAgentOwner";
const PRIVACY_MIGRATION_VERSION = 1;
const PRIVACY_MIGRATION_KEY = "ageePrivacyMigrationVersion";
const PRIVACY_NOTICE_KEY = "ageePrivacyNoticePending";
const BACKGROUND_AUTOMATION_KEY = "ageeBackgroundAutomationEnabled";
const BACKGROUND_AUTOMATION_CONSENT_KEY = "ageeBackgroundAutomationConsentVersion";
const BACKGROUND_AUTOMATION_CONSENT_VERSION = 1;
const PROACTIVE_GRANT_TTL_MS = 10 * 60 * 1000;
const PROACTIVE_CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const PROACTIVE_REQUEST_TIMEOUT_MS = 30 * 1000;
const PROACTIVE_RESPONSE_MAX_BYTES = 64 * 1024;
const PROACTIVE_CONFIRMATION_ALARM = "agee-proactive-confirmation-expiry";
const PROACTIVE_REFUSAL_RECEIPTS_KEY = "ageeProactiveRefusalReceipts";
const PROACTIVE_REFUSAL_RECEIPT_LIMIT = 20;
const PROACTIVE_SIGNAL_KEYS = Object.freeze([
  "article_count",
  "heading_count",
  "paragraph_count",
  "link_count",
  "table_count",
  "list_count",
  "task_count",
  "form_count",
  "editable_count",
  "button_count",
]);
const PROACTIVE_PROMPTS = Object.freeze({
  form: "Help me make a checklist for reviewing this form's structure.",
  table: "Help me plan an analysis for a table.",
  tasks: "Help me organize a task surface.",
  document: "Help me plan a concise document summary.",
});
const proactiveGrants = new Map();
const proactiveConfirmations = new Map();
let proactiveReceiptWrite = Promise.resolve();
let privacyMigrationInFlight = null;
const BROWSER_AGENT_PROGRESS_TEXT = {
  collecting_page_context: "collecting page context",
  capturing_screenshot: "capturing screenshot",
  sending_to_gateway: "sending to gateway",
  waiting_for_answer: "waiting for answer",
  done: "done",
  error: "error",
};
const BROWSER_TURN_STATUS_TIMEOUT_MS = 30000;
const BROWSER_TURN_STATUS_POLL_MS = 400;
// Keep evidence requests well below the gateway's 1 MiB JSON body cap. Text,
// element summaries, and envelope metadata still need room in the same request.
const MAX_BROWSER_EVIDENCE_SCREENSHOT_BASE64_CHARS = 420 * 1024;
const VOICE_AUTO_COMMIT_ENABLED = true;
// 750 (was 900): aligned toward Android's 700ms; this hold is a flat serial
// add to every turn's time-to-first-audio, so keep it as tight as VAD allows.
const VOICE_AUTO_COMMIT_SILENCE_MS = 750;
const VOICE_AUTO_COMMIT_MIN_SPEECH_MS = 220;
// NOT a product limit on how long the user may speak. Speech is streamed to the
// gateway frame-by-frame, so an utterance can run indefinitely. This is only a
// safety backstop that force-commits if the VAD gets stuck and never detects the
// end-of-speech silence — 30 minutes, far past any real turn. Normal turns end
// on the VAD silence auto-commit or on push-to-talk release, not here.
const VOICE_STUCK_VAD_BACKSTOP_MS = 1_800_000;
const VOICE_ACTIVITY_RMS_THRESHOLD = 0.008;
const VOICE_ACTIVITY_PEAK_THRESHOLD = 0.055;
const SELF_EXTENSION_RUNTIME_CACHE_KEY = "ageeSelfExtensionRuntime";
const SELF_EXTENSION_RUNTIME_ALARM = "agee-self-extension-runtime-refresh";
const UI_SPEC_CACHE_KEY = "ageeUiSpec";
const UI_SPEC_ALARM = "agee-ui-spec-refresh";
const UI_SPEC_REFRESH_MIN_MS = 2000;
let uiSpecRefreshInFlight = null;
let uiSpecLastRefreshAt = 0;
const ACTIVE_COMPANION_PET_CACHE_KEY = "ageeActiveCompanionPetCache";
let activeAgentTabId = null;
let creatingOffscreenVoiceDocument = null;
// Capture mutex: counts voice session starts that are still in their async
// setup window (ticket fetch -> voiceSessions registration). Record mode must
// refuse while this is non-zero, or a delayed voice start would steal the
// single offscreen capture slot from an in-flight audio note.
let voiceStartPending = 0;

async function getConfig() {
  return getEffectiveGatewayConfig();
}

function gatewayDiagnosticSuffix(gatewayUrl) {
  const diagnostic = gatewayUrlDiagnostic(gatewayUrl);
  return diagnostic.message ? ` ${diagnostic.message}` : "";
}

function formatGatewayNetworkError(gatewayUrl, path, error) {
  const detail = String(error?.message || error || "").trim();
  const detailSuffix = detail && detail !== "Failed to fetch" ? ` (${detail})` : "";
  return `Could not reach the configured gateway ${gatewayUrl || "(unset)"} while calling ${path}. Check DNS, TLS, and the saved gateway URL.${gatewayDiagnosticSuffix(gatewayUrl)}${detailSuffix}`;
}

function formatGatewayHttpError(cfg, path, resp, text) {
  const gatewayUrl = cfg.gatewayUrl || "(unset)";
  const body = String(text || "").trim().slice(0, 300);
  const diagnostic = gatewayUrlDiagnostic(cfg.gatewayUrl);
  const staleOrLocal = diagnostic.code === "stale_or_local_url";
  const voiceRoute = path.startsWith("/v1/voice/");

  if ((resp.status === 401 || resp.status === 403) && path === "/v1/voice/session-ticket") {
    return `Gateway reachable at ${gatewayUrl}, but the voice ticket was denied (${resp.status}). Check the device token in A.G. Options.`;
  }
  if (resp.status === 401 || resp.status === 403) {
    if (staleOrLocal) {
      return `Gateway reachable at ${gatewayUrl}, but the saved token may belong to a different gateway. Confirm the stable VPS URL, then re-register or paste a fresh token. ${diagnostic.message}`;
    }
    return cfg.gatewayToken
      ? `Gateway reachable at ${gatewayUrl}, but the saved token was rejected (${resp.status}). Re-register this browser or paste a fresh token in A.G. Options.`
      : `Gateway reachable at ${gatewayUrl}, but this route requires a device token (${resp.status}). Add the Gateway token in A.G. Options.`;
  }
  if (resp.status === 404 && voiceRoute) {
    return `Gateway reachable at ${gatewayUrl}, but voice routes are not deployed at this URL (${path} returned 404).`;
  }
  return `Gateway ${gatewayUrl} returned ${resp.status} for ${path}${body ? `: ${body}` : ""}`;
}

function formatVoiceSocketNetworkError(cfg, ticket, reason) {
  const gatewayUrl = cfg.gatewayUrl || "(unset)";
  const detail = String(reason || "").trim();
  const ticketHint = ticket?.ws_url ? " The gateway returned a voice ticket, but the socket did not open." : "";
  return `Voice socket could not connect for configured gateway ${gatewayUrl}.${ticketHint} Check Cloudflare WebSocket proxying, TLS, and the gateway voice route.${gatewayDiagnosticSuffix(gatewayUrl)}${detail ? ` (${detail})` : ""}`;
}

// Pipe a request into the user's own agent gateway instead of the model vendor.
// Returns the parsed JSON body for the given path (e.g. "/v1/browser/turns", "/health").
async function callGateway(cfg, path, {
  method = "POST",
  body,
  signal,
  redirect = "follow",
  maxResponseBytes = 0,
} = {}) {
  if (!cfg.gatewayUrl) {
    throw new Error("No gateway URL set. Open A.G. Options and set the Agent gateway URL.");
  }
  const headers = { "content-type": "application/json" };
  if (cfg.gatewayToken) headers.authorization = `Bearer ${cfg.gatewayToken}`;
  let resp;
  try {
    resp = await fetch(`${cfg.gatewayUrl}${path}`, {
      method,
      signal,
      redirect,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(formatGatewayNetworkError(cfg.gatewayUrl, path, error));
  }
  const text = maxResponseBytes > 0
    ? await readGatewayResponseTextBounded(resp, maxResponseBytes)
    : await resp.text();
  if (!resp.ok) {
    throw new Error(formatGatewayHttpError(cfg, path, resp, text));
  }
  if (resp.status === 204 || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`gateway returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function readGatewayResponseTextBounded(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel("response_too_large"); } catch {}
    throw new Error(`gateway response exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("response_too_large").catch(() => {});
        throw new Error(`gateway response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function gatewayHealth(cfg, signal) {
  return callGateway(cfg, "/health", { method: "GET", signal });
}

const SELF_EXTENSION_RUNTIME_FALLBACK = Object.freeze({
  version: 1,
  active: {},
});

function safeSelfExtensionRuntimePayload(payload) {
  return normalizeSelfExtensionRuntimePayload(payload) || SELF_EXTENSION_RUNTIME_FALLBACK;
}

function normalizeSelfExtensionRuntimePayload(payload) {
  const runtime = payload?.runtime && typeof payload.runtime === "object" ? payload.runtime : payload;
  if (!runtime || typeof runtime !== "object" || runtime.version !== 1) {
    return null;
  }
  return runtime;
}

async function fetchSelfExtensionRuntime() {
  const cfg = await getConfig();
  if (!cfg.gatewayUrl) throw new Error("No gateway URL set.");
  const runtime = normalizeSelfExtensionRuntimePayload(await callGateway(cfg, "/v1/self-extension/runtime", { method: "GET" }));
  if (!runtime) throw new Error("Gateway returned an invalid self-extension runtime.");
  return runtime;
}

async function cachedSelfExtensionRuntimeRecord() {
  if (!chrome?.storage?.local) return null;
  const stored = await chrome.storage.local.get({ [SELF_EXTENSION_RUNTIME_CACHE_KEY]: null });
  const record = stored[SELF_EXTENSION_RUNTIME_CACHE_KEY];
  const runtime = normalizeSelfExtensionRuntimePayload(record?.runtime || record);
  if (!runtime) return null;
  return {
    runtime,
    reason: typeof record?.reason === "string" ? record.reason : "cache",
    updated_at: typeof record?.updated_at === "string" ? record.updated_at : "",
    stale: record?.stale === true,
    stale_reason: typeof record?.stale_reason === "string" ? record.stale_reason : "",
    stale_at: typeof record?.stale_at === "string" ? record.stale_at : "",
  };
}

async function loadSelfExtensionRuntime() {
  try {
    return await fetchSelfExtensionRuntime();
  } catch {
    const cached = await cachedSelfExtensionRuntimeRecord();
    return cached?.runtime || SELF_EXTENSION_RUNTIME_FALLBACK;
  }
}

async function refreshSelfExtensionRuntime(reason = "refresh") {
  try {
    const runtime = await fetchSelfExtensionRuntime();
    if (chrome?.storage?.local) {
      await chrome.storage.local.set({
        [SELF_EXTENSION_RUNTIME_CACHE_KEY]: {
          runtime,
          reason,
          stale: false,
          updated_at: new Date().toISOString(),
        },
      });
    }
    return runtime;
  } catch (error) {
    const cached = await cachedSelfExtensionRuntimeRecord();
    if (cached && chrome?.storage?.local) {
      await chrome.storage.local.set({
        [SELF_EXTENSION_RUNTIME_CACHE_KEY]: {
          ...cached,
          reason,
          stale: true,
          stale_reason: String(error?.message || error).slice(0, 200),
          stale_at: new Date().toISOString(),
        },
      });
      return cached.runtime;
    }
    return SELF_EXTENSION_RUNTIME_FALLBACK;
  }
}

async function startSelfExtensionRuntimeRefresh() {
  if (!chrome?.storage?.local) return;
  await refreshSelfExtensionRuntime("startup");
  if (chrome?.alarms) {
    chrome.alarms.create(SELF_EXTENSION_RUNTIME_ALARM, { periodInMinutes: 0.5 });
  }
}

const UI_SPEC_FALLBACK = Object.freeze({
  spec: { version: 1, surfaces: [] },
  is_customized: false,
});

function normalizeUiSpecPayload(payload) {
  const spec = payload?.spec && typeof payload.spec === "object" ? payload.spec : payload;
  if (!spec || typeof spec !== "object" || spec.version !== 1 || !Array.isArray(spec.surfaces)) {
    return null;
  }
  return {
    spec,
    is_customized: payload?.is_customized === true,
  };
}

async function fetchUiSpec() {
  const cfg = await getConfig();
  if (!cfg.gatewayUrl) throw new Error("No gateway URL set.");
  const payload = normalizeUiSpecPayload(await callGateway(cfg, "/v1/ui/spec", { method: "GET" }));
  if (!payload) throw new Error("Gateway returned an invalid UI spec.");
  return payload;
}

async function cachedUiSpecRecord() {
  if (!chrome?.storage?.local) return null;
  const stored = await chrome.storage.local.get({ [UI_SPEC_CACHE_KEY]: null });
  const record = stored[UI_SPEC_CACHE_KEY];
  const payload = normalizeUiSpecPayload(record?.payload || record);
  if (!payload) return null;
  return {
    payload,
    reason: typeof record?.reason === "string" ? record.reason : "cache",
    updated_at: typeof record?.updated_at === "string" ? record.updated_at : "",
    stale: record?.stale === true,
    stale_reason: typeof record?.stale_reason === "string" ? record.stale_reason : "",
    stale_at: typeof record?.stale_at === "string" ? record.stale_at : "",
  };
}

async function loadUiSpec() {
  try {
    return await fetchUiSpec();
  } catch {
    const cached = await cachedUiSpecRecord();
    return cached?.payload || UI_SPEC_FALLBACK;
  }
}

async function refreshUiSpec(reason = "refresh") {
  const now = Date.now();
  if (uiSpecRefreshInFlight) return uiSpecRefreshInFlight;
  if (now - uiSpecLastRefreshAt < UI_SPEC_REFRESH_MIN_MS) {
    const cached = await cachedUiSpecRecord();
    return cached?.payload || UI_SPEC_FALLBACK;
  }
  uiSpecLastRefreshAt = now;
  uiSpecRefreshInFlight = refreshUiSpecOnce(reason);
  try {
    return await uiSpecRefreshInFlight;
  } finally {
    uiSpecRefreshInFlight = null;
  }
}

async function refreshUiSpecOnce(reason = "refresh") {
  try {
    const payload = await fetchUiSpec();
    if (chrome?.storage?.local) {
      await chrome.storage.local.set({
        [UI_SPEC_CACHE_KEY]: {
          payload,
          reason,
          stale: false,
          updated_at: new Date().toISOString(),
        },
      });
    }
    return payload;
  } catch (error) {
    const cached = await cachedUiSpecRecord();
    if (cached && chrome?.storage?.local) {
      await chrome.storage.local.set({
        [UI_SPEC_CACHE_KEY]: {
          ...cached,
          reason,
          stale: true,
          stale_reason: String(error?.message || error).slice(0, 200),
          stale_at: new Date().toISOString(),
        },
      });
      return cached.payload;
    }
    return UI_SPEC_FALLBACK;
  }
}

// Narrow diagnostic hook for the extension's own worker QA. This object is not
// web-accessible and exposes no gateway response beyond the normal refresh path.
globalThis.AgeeUiSpecRefresh = Object.freeze({ refresh: refreshUiSpec });

async function startUiSpecRefresh() {
  if (!chrome?.storage?.local) return;
  await refreshUiSpec("startup");
  if (chrome?.alarms) {
    chrome.alarms.create(UI_SPEC_ALARM, { periodInMinutes: 0.5 });
  }
}

const ACTIVE_COMPANION_PET_PALETTES = new Set(["graphite", "green", "blue", "violet", "red", "amber", "teal", "mono"]);
const ACTIVE_COMPANION_PET_MOTIONS = new Set(["hover", "peek", "tap", "trail", "float", "walk", "climb", "spark"]);
const ACTIVE_COMPANION_PET_SPRITES = new Set(["css-shigmi", "image-data-url", "image-url"]);

function shortPetString(value, max = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safePetImageDataUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 350 * 1024) return "";
  return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(raw) ? raw : "";
}

function safePetAssetUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 2048) return "";
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return url.href;
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return url.href;
  } catch {}
  return "";
}

function sanitizeActiveCompanionPetRecord(record) {
  if (!record || typeof record !== "object") return null;
  const pet = record.pet && typeof record.pet === "object" ? record.pet : {};
  const sprite = pet.sprite && typeof pet.sprite === "object" ? pet.sprite : {};
  const companionId = shortPetString(record.companion_id || record.id || record.active_companion_id, 100);
  const name = shortPetString(record.companion_name || record.name || record.active_companion_name || pet.name, 80);
  if (!companionId && !name) return null;
  const palette = ACTIVE_COMPANION_PET_PALETTES.has(String(pet.palette || "")) ? String(pet.palette) : "";
  const motion = ACTIVE_COMPANION_PET_MOTIONS.has(String(pet.motion || "")) ? String(pet.motion) : "";
  const spriteType = ACTIVE_COMPANION_PET_SPRITES.has(String(sprite.type || "")) ? String(sprite.type) : "css-shigmi";
  const imageDataUrl = safePetImageDataUrl(sprite.image_data_url);
  const assetUrl = imageDataUrl ? "" : safePetAssetUrl(sprite.asset_url || pet.asset_url);
  const scale = Number(pet.scale);
  return {
    id: companionId,
    companion_id: companionId,
    companion_name: name || "A.G. companion",
    companion_summary: shortPetString(record.companion_summary || record.summary, 180),
    source: shortPetString(record.source, 40),
    pet: {
      renderer: pet.renderer === "shimeji-web" ? "shimeji-web" : "",
      family: shortPetString(pet.family, 40),
      skin: shortPetString(pet.skin, 40),
      palette: palette || "blue",
      motion: motion || "walk",
      scale: Number.isFinite(scale) ? Math.min(Math.max(scale, 0.65), 1.6) : 1,
      sprite: {
        type: imageDataUrl ? "image-data-url" : assetUrl ? "image-url" : spriteType,
        image_data_url: imageDataUrl,
        asset_url: assetUrl,
      },
    },
  };
}

function activeCompanionFromPayload(payload) {
  const direct = payload?.active_companion || payload?.activeCompanion || payload?.pet || payload?.companion;
  return sanitizeActiveCompanionPetRecord(direct);
}

function profileActiveCompanionId(payload) {
  return shortPetString(
    payload?.profile?.active_companion_id ||
      payload?.active_companion_id ||
      payload?.profile?.active_companion?.id ||
      payload?.active_companion?.id,
    100
  );
}

function minimalActiveCompanionFromProfile(payload) {
  const profile = payload?.profile && typeof payload.profile === "object" ? payload.profile : payload || {};
  return sanitizeActiveCompanionPetRecord({
    companion_id: profile.active_companion_id || profile.active_companion?.id,
    companion_name: profile.active_companion_name || profile.active_companion?.name,
    source: profile.active_companion_source || profile.active_companion?.source,
    pet: { renderer: "shimeji-web", palette: "blue", motion: "walk", sprite: { type: "css-shigmi" } },
  });
}

async function cachedActiveCompanionPetRecord() {
  if (!chrome?.storage?.local) return null;
  const stored = await chrome.storage.local.get({ [ACTIVE_COMPANION_PET_CACHE_KEY]: null });
  const record = stored[ACTIVE_COMPANION_PET_CACHE_KEY];
  const activeCompanion = sanitizeActiveCompanionPetRecord(record?.active_companion || record);
  if (!activeCompanion) return null;
  return {
    active_companion: activeCompanion,
    reason: typeof record?.reason === "string" ? record.reason : "cache",
    updated_at: typeof record?.updated_at === "string" ? record.updated_at : "",
  };
}

async function storeActiveCompanionPet(activeCompanion, reason) {
  if (!chrome?.storage?.local) return;
  await chrome.storage.local.set({
    [ACTIVE_COMPANION_PET_CACHE_KEY]: {
      active_companion: activeCompanion,
      reason,
      updated_at: new Date().toISOString(),
    },
  });
}

async function fetchActiveCompanionPet(cfg) {
  try {
    const active = activeCompanionFromPayload(await callGateway(cfg, "/v1/agent/pets/active", { method: "GET" }));
    if (active) return active;
  } catch {
    // Older gateways do not have the active-only route; fall back below.
  }

  const profilePayload = await getGatewayProfile(cfg);
  const activeId = profileActiveCompanionId(profilePayload);
  if (!activeId) return null;
  try {
    const catalog = await callGateway(cfg, "/v1/agent/pets?limit=100", { method: "GET" });
    const pets = Array.isArray(catalog?.pets) ? catalog.pets : [];
    const active = sanitizeActiveCompanionPetRecord(pets.find((item) => item?.companion_id === activeId || item?.id === activeId));
    if (active) return active;
  } catch {
    // If the catalog route is missing/offline after profile resolved, still
    // return a small visual fallback from the profile fields.
  }
  return minimalActiveCompanionFromProfile(profilePayload);
}

async function loadActiveCompanionPet() {
  try {
    const cfg = await getConfig();
    const activeCompanion = await fetchActiveCompanionPet(cfg);
    await storeActiveCompanionPet(activeCompanion, "gateway");
    return { ok: true, active_companion: activeCompanion };
  } catch (error) {
    const cached = await cachedActiveCompanionPetRecord();
    if (cached) return { ok: true, active_companion: cached.active_companion, stale: true };
    return { ok: false, active_companion: null, error: String(error?.message || error) };
  }
}

// ---- Gateway-queued browser tasks -----------------------------------------
// Gemini Live can queue browser work on the gateway. The extension is the only
// component allowed to execute page-local CDP actions, so it claims tasks here,
// runs bounded debugger actions in a disposable background tab, then posts a
// receipt back to the gateway.
const BROWSER_TASK_CLIENT_ID = `agee-extension-${chrome.runtime.id}`;
const BROWSER_TASK_POLL_MS = 2000;
const DEV_RELOAD_ALARM = "agee-dev-reload-poll";
const DEV_RELOAD_DEFAULT_SERVER = "http://localhost:7777";
const DEV_RELOAD_POLL_MS = 1500;
const DEVICE_CLIENT_HEARTBEAT_MS = 15000;
let browserTaskPollInFlight = false;
let browserTaskPollTimer = null;
let browserToolRequestPollInFlight = false;
let devReloadPollTimer = null;
let devReloadPollInFlight = false;
let deviceClientHeartbeatTimer = null;
let deviceClientHeartbeatInFlight = false;

function startBrowserTaskPolling() {
  if (!chrome?.storage?.local || !chrome?.alarms || !chrome?.debugger || !chrome?.tabs) return;
  if (browserTaskPollTimer) return;
  browserTaskPollTimer = setInterval(() => {
    pollBrowserTasks().catch(() => {});
    pollBrowserToolRequests().catch(() => {});
    pollBrowserAgentTasks().catch(() => {});
  }, BROWSER_TASK_POLL_MS);
  chrome.alarms.create("agee-browser-task-poll", { periodInMinutes: 0.5 });
  pollBrowserTasks().catch(() => {});
  pollBrowserToolRequests().catch(() => {});
  pollBrowserAgentTasks().catch(() => {});
}

async function stopBrowserTaskPolling() {
  if (browserTaskPollTimer) clearInterval(browserTaskPollTimer);
  browserTaskPollTimer = null;
  if (chrome?.alarms) await chrome.alarms.clear("agee-browser-task-poll").catch(() => {});
}

// Both the legacy batch path and the agent-loop path are gated by one setting:
// the user opts into (or out of) letting the gateway run background browser work.
async function isBackgroundAutomationEnabled() {
  await initializePrivacyState();
  if (!chrome?.storage?.local) return false;
  try {
    const stored = await chrome.storage.local.get({
      [BACKGROUND_AUTOMATION_KEY]: false,
      [BACKGROUND_AUTOMATION_CONSENT_KEY]: 0,
    });
    return stored[BACKGROUND_AUTOMATION_KEY] === true &&
      stored[BACKGROUND_AUTOMATION_CONSENT_KEY] === BACKGROUND_AUTOMATION_CONSENT_VERSION;
  } catch {
    return false;
  }
}

async function pollBrowserTasks() {
  if (browserTaskPollInFlight) return;
  browserTaskPollInFlight = true;
  try {
    if (!(await isBackgroundAutomationEnabled())) return;
    const cfg = await getConfig();
    if (!cfg.gatewayUrl) return;
    const claimed = await callGateway(cfg, "/v1/browser/tasks/claim", {
      body: { client_id: BROWSER_TASK_CLIENT_ID },
    });
    const task = claimed?.task;
    if (!task?.id) return;
    const receipt = await executeGatewayBrowserTask(task);
    await callGateway(cfg, `/v1/browser/tasks/${encodeURIComponent(task.id)}/receipts`, {
      body: {
        client_id: BROWSER_TASK_CLIENT_ID,
        ...receipt,
      },
    });
  } catch {
    // Polling is background infrastructure; individual task failures are
    // reported as receipts when a task was claimed.
  } finally {
    browserTaskPollInFlight = false;
  }
}

async function pollBrowserToolRequests() {
  if (browserToolRequestPollInFlight) return;
  browserToolRequestPollInFlight = true;
  try {
    if (!(await isBackgroundAutomationEnabled())) return;
    const cfg = await getConfig();
    if (!cfg.gatewayUrl) return;
    const deviceId = await getStableDeviceId();
    const claimed = await callGateway(cfg, "/v1/tool/requests/claim", {
      body: {
        device_id: deviceId,
        surface_type: "browser_extension",
        local_tool_manifest: browserLocalToolManifest(),
      },
    });
    const request = claimed?.request;
    if (!request?.id) return;
    const receipt = await executeBrowserToolRequest(request);
    await callGateway(cfg, `/v1/tool/requests/${encodeURIComponent(request.id)}/receipts`, {
      body: {
        device_id: deviceId,
        ...receipt,
      },
    });
  } catch {
    // Background polling stays quiet; claimed work reports through receipts.
  } finally {
    browserToolRequestPollInFlight = false;
  }
}

async function executeBrowserToolRequest(request) {
  const tool = String(request?.tool || "");
  const input = request?.input && typeof request.input === "object" ? request.input : {};
  try {
    if (tool === "browser.tab.list") {
      const tabs = await chrome.tabs.query({ currentWindow: input.current_window !== false });
      return {
        ok: true,
        summary: `Browser has ${tabs.length} tabs in scope.`,
        result: {
          tabs: tabs.map((tab) => ({
            tab_id: tab.id || null,
            window_id: tab.windowId || null,
            active: tab.active === true,
            title: tab.title || "",
            url: tab.url || "",
          })),
        },
        local_receipt: { tool, success: true },
      };
    }
    if (tool === "browser.tab.open") {
      const url = allowedBrowserTaskUrl(input.url || input.href || input.target);
      if (!url) {
        return { ok: false, error: "blocked or invalid browser.tab.open URL", summary: "Browser tab open request was blocked." };
      }
      const tab = await chrome.tabs.create({ url, active: true });
      return {
        ok: true,
        summary: `Browser opened ${tab.url || url}.`,
        result: { tab_id: tab.id || null, url: tab.url || url },
        local_receipt: { tool, success: true },
      };
    }
    if (tool === "browser.tab.activate") {
      const tabId = Number(input.tab_id ?? input.tabId);
      if (!Number.isFinite(tabId)) {
        return { ok: false, error: "browser.tab.activate requires tab_id", summary: "Browser tab activate request was missing a tab id." };
      }
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return {
        ok: true,
        summary: `Activated browser tab ${tabId}.`,
        result: { tab_id: tabId, title: tab?.title || "", url: tab?.url || "" },
        local_receipt: { tool, success: true },
      };
    }
    if (tool === "browser.tab.close") {
      const tabIds = Array.isArray(input.tab_ids)
        ? input.tab_ids.map((value) => Number(value)).filter((value) => Number.isFinite(value))
        : [Number(input.tab_id ?? input.tabId)].filter((value) => Number.isFinite(value));
      if (!tabIds.length) {
        return { ok: false, error: "browser.tab.close requires tab_id", summary: "Browser tab close request was missing a tab id." };
      }
      await chrome.tabs.remove(tabIds);
      return {
        ok: true,
        summary: `Closed ${tabIds.length} browser tab${tabIds.length === 1 ? "" : "s"}.`,
        result: { tab_ids: tabIds },
        local_receipt: { tool, success: true },
      };
    }
    if (tool === "browser.tab.reload") {
      const tabId = Number(input.tab_id ?? input.tabId);
      if (!Number.isFinite(tabId)) {
        return { ok: false, error: "browser.tab.reload requires tab_id", summary: "Browser tab reload request was missing a tab id." };
      }
      await chrome.tabs.reload(tabId, { bypassCache: input.bypass_cache === true });
      return {
        ok: true,
        summary: `Reloaded browser tab ${tabId}.`,
        result: { tab_id: tabId },
        local_receipt: { tool, success: true },
      };
    }
    if (tool === "page.snapshot") {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      if (!active?.id) {
        return { ok: false, error: "no active tab", summary: "No active browser tab was available." };
      }
      await ensureContent(active.id);
      const snap = await ask(active.id, { cmd: "snapshot" });
      return {
        ok: true,
        summary: `Captured page snapshot for ${snap?.title || active.title || "active tab"}.`,
        result: { screen: snapToScreen(snap) },
        local_receipt: { tool, success: true },
      };
    }
    if (tool === "browser.cdp.execute") {
      const requestedTabId = Number(input.tab_id ?? input.tabId);
      const tab = Number.isFinite(requestedTabId)
        ? await chrome.tabs.get(requestedTabId)
        : (await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []))[0];
      if (!tab?.id) {
        return { ok: false, error: "no target tab", summary: "No browser tab was available for CDP execution." };
      }
      const actions = Array.isArray(input.cdp_actions) ? input.cdp_actions : Array.isArray(input.actions) ? input.actions : [];
      const result = await executeCdpActionsOnTab(tab.id, actions);
      return {
        ok: result.ok,
        summary: `Executed ${result.action_results.length} CDP browser action${result.action_results.length === 1 ? "" : "s"} on ${tab.title || "active tab"}.`,
        result,
        local_receipt: { tool, success: result.ok },
      };
    }
    if (tool === "browser.task.claim") {
      return {
        ok: true,
        summary: "Browser queued-task claim loop is active.",
        local_receipt: { tool, success: true },
      };
    }
    return { ok: false, error: `unsupported browser tool: ${tool}`, summary: `Unsupported browser tool: ${tool}` };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      summary: `Browser tool request failed: ${tool}`,
      local_receipt: { tool, success: false },
    };
  }
}

async function executeGatewayBrowserTask(task) {
  let bgTabId = null;
  let attached = false;
  const target = {};
  const actionResults = [];
  let screenshot = null;
  let pageState = null;
  try {
    const startUrl = await browserTaskStartUrl(task);
    const bgTab = await chrome.tabs.create({ url: "about:blank", active: false });
    bgTabId = bgTab.id;
    target.tabId = bgTabId;
    await debuggerAttach(target);
    attached = true;
    await debuggerSend(target, "Page.enable");
    await debuggerSend(target, "Runtime.enable");

    if (startUrl) {
      await debuggerSend(target, "Page.navigate", { url: startUrl });
      await waitForBackgroundTabLoad(bgTabId);
    }

    const actions = Array.isArray(task.cdp_actions) && task.cdp_actions.length
      ? task.cdp_actions
      : defaultBrowserTaskActions(task);

    for (const action of actions) {
      const method = String(action?.method || "");
      const params = action?.params && typeof action.params === "object" ? action.params : {};
      if (!isAllowedQueuedCdpMethod(method)) {
        actionResults.push({ method, ok: false, error: "blocked CDP method" });
        continue;
      }
      try {
        const result = await debuggerSend(target, method, params);
        if (method === "Page.navigate") {
          await waitForBackgroundTabLoad(bgTabId);
        }
        if (method === "Page.captureScreenshot") {
          screenshot = { format: params.format || "png", bytes: result?.data ? result.data.length : 0 };
        }
        actionResults.push({ method, ok: true, value: compactCdpResult(result) });
      } catch (error) {
        actionResults.push({ method, ok: false, error: String(error?.message || error) });
      }
    }

    pageState = await readCdpPageState(target);
    if (!screenshot) {
      const shot = await debuggerSend(target, "Page.captureScreenshot", { format: "jpeg", quality: 35 });
      screenshot = { format: "jpeg", bytes: shot?.data ? shot.data.length : 0 };
    }

    const title = pageState?.title || "(untitled)";
    return {
      ok: actionResults.every((result) => result.ok !== false),
      summary: `Browser task completed in background tab: ${title}`,
      action_results: actionResults,
      page_state: pageState,
      screenshot,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      summary: "Browser task failed in extension CDP executor.",
      action_results: actionResults,
      page_state: pageState,
      screenshot,
    };
  } finally {
    if (attached) await debuggerDetach(target);
    if (bgTabId != null) {
      try {
        await chrome.tabs.remove(bgTabId);
      } catch {
        // already gone
      }
    }
  }
}

async function executeCdpActionsOnTab(tabId, actions) {
  let attached = false;
  const target = { tabId };
  const actionResults = [];
  let pageState = null;
  let screenshot = null;
  try {
    await debuggerAttach(target);
    attached = true;
    await debuggerSend(target, "Page.enable");
    await debuggerSend(target, "Runtime.enable");
    const cdpActions = Array.isArray(actions) && actions.length ? actions : defaultBrowserTaskActions();
    for (const action of cdpActions) {
      const method = String(action?.method || "");
      const params = action?.params && typeof action.params === "object" ? { ...action.params } : {};
      if (!isAllowedQueuedCdpMethod(method)) {
        actionResults.push({ method, ok: false, error: "blocked CDP method" });
        continue;
      }
      if (method === "Page.navigate") {
        const url = allowedBrowserTaskUrl(params.url);
        if (!url) {
          actionResults.push({ method, ok: false, error: "blocked or invalid navigation URL" });
          continue;
        }
        params.url = url;
      }
      try {
        const result = await debuggerSend(target, method, params);
        if (method === "Page.navigate") await waitForBackgroundTabLoad(tabId);
        if (method === "Page.captureScreenshot") {
          screenshot = { format: params.format || "png", bytes: result?.data ? result.data.length : 0 };
        }
        actionResults.push({ method, ok: true, value: compactCdpResult(result) });
      } catch (error) {
        actionResults.push({ method, ok: false, error: String(error?.message || error) });
      }
    }
    pageState = await readCdpPageState(target).catch(() => null);
    return {
      ok: actionResults.every((result) => result.ok !== false),
      tab_id: tabId,
      action_results: actionResults,
      page_state: pageState,
      screenshot,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      tab_id: tabId,
      action_results: actionResults,
      page_state: pageState,
      screenshot,
    };
  } finally {
    if (attached) await debuggerDetach(target);
  }
}

async function browserTaskStartUrl(task) {
  const explicit = allowedBrowserTaskUrl(task?.url);
  if (explicit) return explicit;
  const owner = await getActiveBrowserAgentOwner();
  const ownerTabId = Number(owner?.tab_id ?? owner?.tabId);
  if (Number.isFinite(ownerTabId)) {
    try {
      const tab = await chrome.tabs.get(ownerTabId);
      const ownerUrl = allowedBrowserTaskUrl(tab?.url || owner?.page_url);
      if (ownerUrl) return ownerUrl;
    } catch {
      const ownerUrl = allowedBrowserTaskUrl(owner?.page_url);
      if (ownerUrl) return ownerUrl;
    }
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  return allowedBrowserTaskUrl(active?.url);
}

function allowedBrowserTaskUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ALLOWED_NAVIGATION_PROTOCOLS.has(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function defaultBrowserTaskActions() {
  return [
    { method: "Runtime.evaluate", params: { expression: "JSON.stringify({ title: document.title, url: location.href, ready: document.readyState })", returnByValue: true } },
    { method: "Page.captureScreenshot", params: { format: "jpeg", quality: 40 } },
  ];
}

function isAllowedQueuedCdpMethod(method) {
  return method === "Page.navigate" ||
    method === "Runtime.evaluate" ||
    method === "Input.dispatchKeyEvent" ||
    method === "Input.insertText" ||
    method === "Page.captureScreenshot";
}

function compactCdpResult(result) {
  if (!result || typeof result !== "object") return null;
  if (result.data) {
    return { data_bytes: String(result.data).length };
  }
  if (result.result?.value != null) {
    return result.result.value;
  }
  return JSON.stringify(result).slice(0, 1000);
}

async function readCdpPageState(target) {
  const evalRes = await debuggerSend(target, "Runtime.evaluate", {
    expression: "JSON.stringify({ title: document.title, url: location.href, ready: document.readyState })",
    returnByValue: true,
  });
  try {
    return JSON.parse(evalRes?.result?.value || "{}");
  } catch {
    return {};
  }
}

if (chrome?.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === PROACTIVE_CONFIRMATION_ALARM) {
      expireProactiveConfirmations();
    } else if (alarm.name === "agee-browser-task-poll") {
      pollBrowserTasks().catch(() => {});
      pollBrowserToolRequests().catch(() => {});
      pollBrowserAgentTasks().catch(() => {});
    } else if (alarm.name === DEV_RELOAD_ALARM) {
      pollDevReloadVersion("alarm").catch(() => {});
    } else if (alarm.name === SELF_EXTENSION_RUNTIME_ALARM || alarm.name === UI_SPEC_ALARM) {
      // Privacy migration v1 retired passive customization refreshes. Cached
      // runtime/spec data remains usable and explicit turns refresh it.
      chrome.alarms.clear(alarm.name).catch(() => {});
    }
  });
}

async function initializePrivacyState() {
  if (privacyMigrationInFlight) return privacyMigrationInFlight;
  privacyMigrationInFlight = (async () => {
    if (!chrome?.storage?.local) return;
    const stored = await chrome.storage.local.get({
      [PRIVACY_MIGRATION_KEY]: 0,
      [ACTIVE_BROWSER_AGENT_OWNER_KEY]: null,
    });
    if (Number(stored[PRIVACY_MIGRATION_KEY] || 0) >= PRIVACY_MIGRATION_VERSION) return;
    const owner = stored[ACTIVE_BROWSER_AGENT_OWNER_KEY];
    let scrubbedOwner = owner;
    if (owner && typeof owner === "object") {
      const { page_url: _pageUrl, page_title: _pageTitle, ...withoutPageIdentity } = owner;
      scrubbedOwner = withoutPageIdentity;
    }
    await chrome.storage.local.set({
      [PRIVACY_MIGRATION_KEY]: PRIVACY_MIGRATION_VERSION,
      [BACKGROUND_AUTOMATION_KEY]: false,
      [BACKGROUND_AUTOMATION_CONSENT_KEY]: 0,
      [PRIVACY_NOTICE_KEY]: {
        version: PRIVACY_MIGRATION_VERSION,
        code: "privacy_defaults_changed",
        pending: true,
      },
      ...(scrubbedOwner ? { [ACTIVE_BROWSER_AGENT_OWNER_KEY]: scrubbedOwner } : {}),
    });
    for (const confirmation of [...proactiveConfirmations.values()]) {
      removeProactiveConfirmation(confirmation, "privacy_migration", { closeWindow: true, notify: true });
    }
    proactiveGrants.clear();
    if (chrome?.alarms) {
      await Promise.allSettled([
        chrome.alarms.clear("agee-browser-task-poll"),
        chrome.alarms.clear(PROACTIVE_CONFIRMATION_ALARM),
        chrome.alarms.clear(SELF_EXTENSION_RUNTIME_ALARM),
        chrome.alarms.clear(UI_SPEC_ALARM),
      ]);
    }
  })().finally(() => {
    privacyMigrationInFlight = null;
  });
  return privacyMigrationInFlight;
}

async function syncBackgroundAutomationRuntime() {
  if (await isBackgroundAutomationEnabled()) {
    startBrowserTaskPolling();
    await startDeviceClientHeartbeat();
    return;
  }
  await stopBrowserTaskPolling();
  stopDeviceClientHeartbeat();
}

async function initializePassiveRuntime() {
  await initializePrivacyState();
  await syncBackgroundAutomationRuntime();
  await startDevReloadPolling();
  await reloadDevTabsAfterExtensionRestart();
}

initializePassiveRuntime().catch(() => {});

// ---- Gateway device-client heartbeat --------------------------------------
// The gateway is the shared registry; the extension advertises only browser-local
// capabilities. It does not execute phone actions and it never stores provider
// keys.
async function startDeviceClientHeartbeat() {
  if (!chrome?.storage?.local) return;
  if (!(await isBackgroundAutomationEnabled())) return;
  if (deviceClientHeartbeatTimer) return;
  deviceClientHeartbeatTimer = setInterval(() => {
    heartbeatDeviceClient().catch(() => {});
  }, DEVICE_CLIENT_HEARTBEAT_MS);
  heartbeatDeviceClient().catch(() => {});
}

function stopDeviceClientHeartbeat() {
  if (deviceClientHeartbeatTimer) clearInterval(deviceClientHeartbeatTimer);
  deviceClientHeartbeatTimer = null;
}

async function heartbeatDeviceClient() {
  if (deviceClientHeartbeatInFlight) return;
  deviceClientHeartbeatInFlight = true;
  try {
    if (!(await isBackgroundAutomationEnabled())) return;
    const cfg = await getConfig();
    if (!cfg.gatewayUrl) return;
    const deviceId = await getStableDeviceId();
    const sessionId = await getStableSessionId();
    const owner = await getActiveBrowserAgentOwner();
    const sessionAdvertisement = await currentBrowserSessionAdvertisement();
    await callGateway(cfg, "/v1/device-clients/heartbeat", {
      body: {
        device_id: deviceId,
        surface_type: "browser_extension",
        status: "online",
        local_tool_manifest: browserLocalToolManifest(),
        metadata: {
          source: "agee-extension",
          extension_version: chrome.runtime.getManifest().version,
          extension_id: chrome.runtime.id,
          active_owner: owner || null,
          context_descriptor: sessionAdvertisement.context_descriptor,
          execution_adapters: sessionAdvertisement.execution_adapters,
        },
      },
    });
  } finally {
    deviceClientHeartbeatInFlight = false;
  }
}

async function currentBrowserSessionAdvertisement() {
  let active = null;
  try {
    [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    // A missing active tab is represented explicitly below. Heartbeat remains
    // useful for device presence even when page identity cannot be observed.
  }
  const contextDescriptor = browserContextDescriptor(active);
  return {
    context_descriptor: contextDescriptor,
    execution_adapters: browserSessionExecutionAdapters(contextDescriptor),
  };
}

function browserLocalToolManifest() {
  return [
    { tool: "browser.tab.list", risk: "read_only", approval: "none" },
    { tool: "browser.tab.open", risk: "navigation", approval: "implicit_user_command" },
    { tool: "browser.tab.activate", risk: "navigation", approval: "implicit_user_command" },
    { tool: "browser.tab.close", risk: "destructive_browser_local", approval: "implicit_user_command" },
    { tool: "browser.tab.reload", risk: "navigation", approval: "implicit_user_command" },
    { tool: "browser.cdp.execute", risk: "browser_local_debugger", approval: "implicit_user_command" },
    { tool: "browser.task.claim", risk: "browser_local", approval: "none" },
    { tool: "page.snapshot", risk: "read_only", approval: "none" },
  ];
}

// ---- Gateway browser agent-loop tasks -------------------------------------
// The persistent-task upgrade over executeGatewayBrowserTask: the gateway drives
// a MULTI-STEP autonomous browser agent. Each step the extension builds an
// observation (content-script snapshot + optional screenshot), POSTs it, and the
// gateway returns ONE bounded declarative action. The extension validates that
// action against its own local vocabulary (no eval, no code strings, no CSS/JS
// over the wire) before executing it in a persistent background tab that never
// becomes active. Gated by the same ageeBackgroundAutomationEnabled setting as
// the legacy batch path; only one agent-loop task runs at a time.
let browserAgentTaskPollInFlight = false;
let agentLoopTaskActive = false;

// Same 2s cadence/alarm structure as pollBrowserTasks. Claim one agent-loop task
// and drive it to completion. While a task is active we do not claim another.
async function pollBrowserAgentTasks() {
  if (browserAgentTaskPollInFlight || agentLoopTaskActive) return;
  browserAgentTaskPollInFlight = true;
  try {
    if (!(await isBackgroundAutomationEnabled())) return;
    const cfg = await getConfig();
    if (!cfg.gatewayUrl) return;
    const claimed = await callGateway(cfg, "/v1/browser/agent-tasks/claim", {
      body: { client_id: BROWSER_TASK_CLIENT_ID },
    });
    const task = claimed?.task;
    if (!task?.id) return;
    agentLoopTaskActive = true;
    // Register a cue + AbortController so stop-intent can cancel the loop like
    // any other task. The agentLoop marker keeps ownership changes
    // (claimActiveAgentTab) from aborting this background task on ordinary user
    // activity, while stop-intent still cancels it.
    const cueId = nextCueId(`agent-loop-${task.id}`);
    const controller = new AbortController();
    tasks.set(cueId, { controller, tabId: null, agentLoop: true });
    try {
      await runAgentLoopTask(task, cfg, controller, cueId);
    } finally {
      if (tasks.get(cueId)?.controller === controller) tasks.delete(cueId);
      agentLoopTaskActive = false;
    }
  } catch {
    // Background polling stays quiet; a claimed task reports through finish.
  } finally {
    browserAgentTaskPollInFlight = false;
  }
}

async function runAgentLoopTask(task, cfg, controller, cueId) {
  const signal = controller.signal;
  const taskId = String(task.id);
  const maxSteps = clampAgentLoopMaxSteps(task.max_steps);
  let bgTabId = null;
  let lastAction = null;
  let lastActionResult = "";
  let captureNext = true; // step 0 always carries a screenshot
  try {
    const startUrl = allowedBrowserTaskUrl(task.url) || "about:blank";
    // Persistent background tab: never activated, kept alive across every step.
    const bgTab = await chrome.tabs.create({ url: startUrl, active: false });
    bgTabId = bgTab.id;
    const entry = tasks.get(cueId);
    if (entry) entry.tabId = bgTabId;
    if (allowedBrowserTaskUrl(task.url)) {
      await waitForBackgroundTabLoad(bgTabId);
    }
    for (let step = 0; step < maxSteps; step += 1) {
      throwIfAborted(signal);
      const observation = await buildAgentLoopObservation(bgTabId, step, {
        withScreenshot: captureNext,
        lastAction,
        lastActionResult,
      });
      captureNext = false;
      throwIfAborted(signal);
      const response = await callGateway(cfg, `/v1/browser/agent-tasks/${encodeURIComponent(taskId)}/steps`, {
        signal,
        body: { observation },
      });
      const validation = validateAgentLoopAction(response?.action, allowedBrowserTaskUrl);
      if (!validation.ok) {
        await finishAgentLoopTask(cfg, taskId, "failed", `rejected action ${validation.kind}`);
        return;
      }
      const action = validation.action;
      if (action.kind === "finish") {
        // The finish action status is done|blocked; the finish endpoint status
        // is done|failed|cancelled. A deliberate block did not achieve the goal,
        // so it maps to failed with the summary carried through.
        const status = action.status === "blocked" ? "failed" : "done";
        await finishAgentLoopTask(cfg, taskId, status, action.summary || (status === "done" ? "task complete" : "agent blocked"));
        return;
      }
      lastActionResult = await executeAgentLoopAction(bgTabId, action, signal);
      lastAction = action;
      if (action.kind === "screenshot") captureNext = true;
      if (response?.done === true) {
        await finishAgentLoopTask(cfg, taskId, "done", "task complete");
        return;
      }
    }
    await finishAgentLoopTask(cfg, taskId, "done", `reached the ${maxSteps}-step limit`);
  } catch (error) {
    const cancelled = signal.aborted;
    await finishAgentLoopTask(
      cfg,
      taskId,
      cancelled ? "cancelled" : "failed",
      cancelled ? "cancelled by stop" : String(error?.message || error),
    ).catch(() => {});
  } finally {
    if (bgTabId != null) {
      try {
        await chrome.tabs.remove(bgTabId);
      } catch {
        // already gone
      }
    }
  }
}

// Best-effort content-script presence. On about:blank or a restricted page the
// injection throws and the snapshot below falls back to {url,title}.
async function ensureAgentLoopContent(tabId) {
  try {
    await ensureContent(tabId);
  } catch {
    // restricted/blank page
  }
}

async function buildAgentLoopObservation(tabId, step, { withScreenshot, lastAction, lastActionResult }) {
  await ensureAgentLoopContent(tabId);
  const snapshot = await collectBrowserSnapshot(tabId);
  const screenshot = withScreenshot ? await captureScreenshotViaDebugger(tabId) : "";
  return buildAgentLoopObservationPayload(snapshot, step, {
    withScreenshot,
    screenshot,
    lastAction,
    lastActionResult,
  });
}

// Execute one validated action against the persistent background tab. Element
// actions go through the content-script act path; navigate uses chrome.tabs
// (http/https only, enforced by the validator); wait sleeps; screenshot is a
// no-op that the next observation captures.
async function executeAgentLoopAction(tabId, action, signal) {
  throwIfAborted(signal);
  switch (action.kind) {
    case "navigate":
      await chrome.tabs.update(tabId, { url: action.url });
      await waitForBackgroundTabLoad(tabId);
      return `navigated to ${action.url}`;
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return "waited";
    case "screenshot":
      return "screenshot captured with next observation";
    case "click":
    case "type":
    case "clear":
    case "select":
    case "scroll":
    case "key": {
      await ensureAgentLoopContent(tabId);
      let result;
      try {
        result = await ask(tabId, {
          cmd: "act",
          action: action.kind,
          index: action.index,
          text: action.text,
          direction: action.direction,
          background: true,
        });
      } catch {
        // Page likely navigated and tore down the content script.
        await waitForBackgroundTabLoad(tabId);
        return "action sent; page navigated";
      }
      // Settle: clicks/typing may trigger async updates or navigation.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return (result && result.result) || "done";
    }
    default:
      return `unhandled action ${action.kind}`;
  }
}

async function finishAgentLoopTask(cfg, taskId, status, summary) {
  return callGateway(cfg, `/v1/browser/agent-tasks/${encodeURIComponent(taskId)}/finish`, {
    body: {
      status,
      summary: String(summary || "").slice(0, AGENT_LOOP_MAX_SUMMARY),
    },
  });
}

// Stop-intent path: abort every active agent-loop cue. runAgentLoopTask then
// posts finish { status:"cancelled" } and disposes its background tab.
function cancelAgentLoopCues() {
  for (const [cueId, task] of [...tasks]) {
    if (!task.agentLoop) continue;
    try {
      task.controller.abort();
    } catch {}
    tasks.delete(cueId);
  }
}

// ---- Developer auto-reload -----------------------------------------------
// Disabled by default. The developer bridge (`dev.html`) opts this in by
// writing ageeDevReloadEnabled + ageeDevReloadServer to storage. Once enabled,
// the already-loaded extension can notice source edits without keeping the
// bridge page open: active content scripts poll the dev server and this
// background worker also polls while awake / via alarms.

async function startDevReloadPolling() {
  if (!chrome?.storage?.local || !chrome?.alarms) return;
  const cfg = await devReloadConfig();
  if (!cfg.enabled) return;
  ensureDevReloadTimer();
}

function ensureDevReloadTimer() {
  if (devReloadPollTimer) return;
  devReloadPollTimer = setInterval(() => {
    pollDevReloadVersion("interval").catch(() => {});
  }, DEV_RELOAD_POLL_MS);
  chrome.alarms.create(DEV_RELOAD_ALARM, { periodInMinutes: 0.5 });
  pollDevReloadVersion("startup").catch(() => {});
}

async function stopDevReloadTimer() {
  if (devReloadPollTimer) {
    clearInterval(devReloadPollTimer);
    devReloadPollTimer = null;
  }
  try {
    await chrome.alarms.clear(DEV_RELOAD_ALARM);
  } catch {}
}

// installType "development" means an unpacked load — the only install kind the
// localhost reload bridge can ever apply to. getSelf needs no extra permission.
let cachedInstallType = null;
async function extensionInstallType() {
  if (cachedInstallType) return cachedInstallType;
  try {
    const info = await chrome.management?.getSelf?.();
    cachedInstallType = info?.installType || "unknown";
  } catch {
    cachedInstallType = "unknown";
  }
  return cachedInstallType;
}

async function devReloadConfig() {
  const stored = await chrome.storage.local.get({
    ageeDevReloadEnabled: null,
    ageeDevReloadServer: DEV_RELOAD_DEFAULT_SERVER,
    ageeDevReloadVersion: null,
  });
  const server = String(stored.ageeDevReloadServer || DEV_RELOAD_DEFAULT_SERVER).replace(/\/+$/, "");
  // Unpacked installs auto-enable the bridge so scripts/deploy.sh reload pokes
  // actually land without a manual dev.html opt-in. An explicit stored boolean
  // (from dev.html) always wins in either direction.
  let enabled = stored.ageeDevReloadEnabled;
  if (enabled == null) {
    enabled = (await extensionInstallType()) === "development";
  }
  return {
    enabled: Boolean(enabled),
    server,
    version: stored.ageeDevReloadVersion == null ? null : Number(stored.ageeDevReloadVersion),
  };
}

async function fetchDevReloadVersion(server) {
  const resp = await fetch(`${server}/__agee-dev/version?ts=${Date.now()}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(`dev server returned ${resp.status}`);
  return resp.json();
}

async function pollDevReloadVersion(source) {
  if (devReloadPollInFlight) return;
  devReloadPollInFlight = true;
  try {
    const cfg = await devReloadConfig();
    if (!cfg.enabled) {
      await stopDevReloadTimer();
      return;
    }
    const info = await fetchDevReloadVersion(cfg.server);
    await maybeReloadForDevVersion(info, { server: cfg.server, previousVersion: cfg.version, source });
  } catch {
    // Dev server may be offline. Keep quiet; dev.html surfaces connection state.
  } finally {
    devReloadPollInFlight = false;
  }
}

async function maybeReloadForDevVersion(info, { server, previousVersion, source }) {
  const nextVersion = Number(info?.version || 0);
  if (!nextVersion) return;
  if (!previousVersion) {
    await chrome.storage.local.set({ ageeDevReloadVersion: nextVersion });
    return;
  }
  if (nextVersion === previousVersion) return;
  await chrome.storage.local.set({
    ageeDevReloadVersion: nextVersion,
    ageeDevReloadPendingLocalhostRefresh: true,
    ageeDevReloadLastReload: {
      previousVersion,
      nextVersion,
      source,
      server,
      at: new Date().toISOString(),
    },
  });
  chrome.runtime.reload();
}

async function reloadDevTabsAfterExtensionRestart() {
  if (!chrome?.storage?.local || !chrome?.tabs) return;
  const { ageeDevReloadPendingLocalhostRefresh } = await chrome.storage.local.get({
    ageeDevReloadPendingLocalhostRefresh: false,
  });
  if (!ageeDevReloadPendingLocalhostRefresh) return;
  await chrome.storage.local.set({ ageeDevReloadPendingLocalhostRefresh: false });
  await reloadLocalhostTabs();
}

async function reloadLocalhostTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://localhost/*", "http://127.0.0.1/*"] });
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => chrome.tabs.reload(tab.id).catch(() => {})));
}

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    // When the user points the extension at a different gateway (or pastes a new
    // token), re-adopt that gateway's canonical shared session id.
    if (changes.ageeGatewayUrl || changes.ageeGatewayToken) {
      revokeAllProactiveGrants("destination_changed");
      adoptSharedGatewaySession("gateway config changed").catch(() => {});
    }
    if (changes[BACKGROUND_AUTOMATION_KEY] || changes[BACKGROUND_AUTOMATION_CONSENT_KEY]) {
      syncBackgroundAutomationRuntime().catch(() => {});
    }
    if (!changes.ageeDevReloadEnabled && !changes.ageeDevReloadServer) return;
    const enabled = Boolean(changes.ageeDevReloadEnabled?.newValue);
    if (enabled) ensureDevReloadTimer();
    else if (changes.ageeDevReloadEnabled) stopDevReloadTimer().catch(() => {});
  });
}

// ---- Router activation loop (the gateway side of a branch) -----------------
// The sterile router on the gateway launches a disposable agent run and never
// speaks. We POST the intent to /v1/router/activate (202 + run id), then poll
// /v1/router/activations/:id for the durable router_ping the gateway emits on
// completion. This is the loop the integration fuses to the CDP task agent: the
// gateway tracks + pings the run, the browser does the actual page work.
//
// `parentRunId` threads fan-out lineage so two concurrent activations share a
// parent. The harness/echo output stays a proposal — we only render its summary.
async function routerActivate(cfg, { intent, screen, parentRunId, signal }) {
  const deviceId = await getStableDeviceId();
  const body = { intent, source: "agee-extension", device_id: deviceId };
  if (screen) body.screen = screen;
  if (parentRunId) body.parent_run_id = parentRunId;
  const activation = await callGateway(cfg, "/v1/router/activate", { signal, body });
  const runId = activation && (activation.run_id || activation.activation_id);
  if (!runId) throw new Error("router activate returned no run id");
  return { runId, statusUrl: activation.status_url || `/v1/router/activations/${runId}` };
}

// Poll a router activation until its durable router_ping appears (or timeout).
// Returns the ping event { type:"router_ping", ok, run_status, summary, ... }.
async function waitForRouterPing(cfg, runId, signal, { timeoutMs = 12000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    last = await callGateway(cfg, `/v1/router/activations/${runId}`, { method: "GET", signal });
    if (last && last.ping) return last.ping;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`router activation ${runId} did not ping in time`);
}

// ---- Runtime agent profile (the settings the agent reads/writes) ----------
// Cache key shared with the options page so a change applied here refreshes an
// open settings surface live (chrome.storage.onChanged).
const PROFILE_CACHE_KEY = "ageeProfileCache";

// Read the effective profile from the gateway (GET /v1/agent/profile).
async function getGatewayProfile(cfg, signal) {
  return callGateway(cfg, "/v1/agent/profile", { method: "GET", signal });
}

// Patch + persist a profile change through the gateway (PUT /v1/agent/profile)
// and cache the authoritative result so the settings surface stays in sync.
async function putGatewayProfile(cfg, patch, signal, source = "agee-extension", options = {}) {
  const deviceId = await getStableDeviceId();
  const payload = await callGateway(cfg, "/v1/agent/profile", {
    method: "PUT",
    signal,
    body: {
      profile: patch,
      source,
      scope: options.scope || "global",
      device_id: deviceId,
    },
  });
  await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: payload });
  return payload;
}

// Read the queryable prompt-change history from the gateway.
async function getGatewayProfileHistory(cfg, signal) {
  return callGateway(cfg, "/v1/agent/profile/history?system_prompt_only=1&limit=50", { method: "GET", signal });
}

// Profile fields the gateway owns end to end. The local settings matcher is no
// longer allowed to write these; the gateway profile classifier is the single
// writer (it sanitizes and can reject with a spoken reply). Everything else in a
// patch stays local for now.
const SERVER_OWNED_PROFILE_FIELDS = new Set([
  "system_prompt",
  "language",
  "language_mode",
  "language_primary",
  "language_output",
  "language_auto_switch",
  "input_languages",
  "input_language_primary",
  "voice",
]);

function withoutServerOwnedProfileFields(patch) {
  if (!patch || typeof patch !== "object") return patch;
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SERVER_OWNED_PROFILE_FIELDS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

// "Change settings by talking to the agent": if the instruction is a settings
// request, turn it into a concrete profile patch and apply it through the
// gateway profile endpoints, then render a confirmation. Returns true when the
// instruction was handled as a settings change (so the caller skips the normal
// conversational turn); false otherwise.
async function maybeApplySettingsChange(tabId, instruction, cfg, signal, cueId) {
  // A quick pre-check avoids a profile GET for ordinary commands: only fetch
  // the current profile (needed for relative changes like "be terser") when the
  // text already looks like a settings intent given gateway defaults.
  let current = null;
  if (!parseSettingsIntent(instruction, current)) {
    return false;
  }
  try {
    const profilePayload = await getGatewayProfile(cfg, signal);
    current = profilePayload?.profile || null;
    await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: profilePayload });
  } catch {
    // Fall back to defaults-based parsing if the GET fails; the PUT below will
    // surface any real gateway error loudly.
  }

  const intent = parseSettingsIntent(instruction, current);
  if (!intent) return false;

  // Demote the local writer for fields the gateway owns end to end. Language,
  // voice, and system-prompt requests already route to the gateway profile
  // classifier (looksLikeGatewayProfileControlIntent) earlier in the chain, and
  // the gateway is the single writer for them: it sanitizes, rejects, and replies.
  // Strip those fields here so this local path never double-writes them. The
  // fields with no gateway equivalent yet — temperature, voice_max_chars
  // (terser/verbose), model — stay local for now (follow-up: move them too).
  const patch = withoutServerOwnedProfileFields(intent.patch);
  if (!patch || Object.keys(patch).length === 0) {
    // Everything in this intent is gateway-owned; let the gateway path handle it.
    return false;
  }

  await saveTaskState(cueId, { status: "running", instruction, step: 0, lastResult: "applying settings change", tabId });
  send(tabId, { cmd: "progress", cueId, text: "updating settings…" });
  throwIfAborted(signal);

  await putGatewayProfile(cfg, patch, signal, "agee-extension", { scope: intent.scope || "global" });
  const summary = `Settings updated — ${intent.summary}. It takes effect on the next turn.`;
  send(tabId, { cmd: "done", cueId, summary });
  await saveTaskState(cueId, { status: "done", instruction, step: 1, lastResult: summary.slice(0, 400), tabId });
  return true;
}

// "What prompts have I set?" / "how many system prompts?" → answer from the
// gateway's prompt-change history instead of running a model turn.
async function maybeAnswerProfileQuery(tabId, instruction, cfg, signal, cueId) {
  if (!parseProfileQueryIntent(instruction)) {
    return false;
  }
  send(tabId, { cmd: "progress", cueId, text: "checking prompt history…" });
  throwIfAborted(signal);
  let data;
  try {
    data = await getGatewayProfileHistory(cfg, signal);
  } catch (error) {
    send(tabId, { cmd: "error", cueId, text: `Could not read prompt history: ${String(error?.message || error)}` });
    return true;
  }
  const count = Number(data?.system_prompt_changes || 0);
  const entries = Array.isArray(data?.history) ? data.history : [];
  const lines = [
    count === 0
      ? "You haven't set any system prompts yet."
      : `You've set ${count} system prompt${count === 1 ? "" : "s"}.`,
  ];
  if (data?.current_system_prompt) {
    lines.push(`Current: "${truncate(data.current_system_prompt, 160)}"`);
  }
  entries.slice(0, 5).forEach((entry, i) => {
    const when = String(entry.ts || "").replace("T", " ").slice(0, 16);
    lines.push(`${i + 1}. [${when}] ${truncate(entry.system_prompt || "", 120)}`);
  });
  const summary = lines.join("\n");
  send(tabId, { cmd: "done", cueId, summary, speak: lines[0] });
  await saveTaskState(cueId, { status: "done", instruction, step: 1, lastResult: summary.slice(0, 400), tabId });
  return true;
}

// Voice/language/profile controls belong in the canonical gateway turn router,
// even when typed. That path stores a profile_control turn and applies the
// versioned profile update/query. Keep the direct PUT fallback below for older
// extension-only tweaks the gateway parser does not yet understand.
async function maybeRouteGatewayProfileControl(tabId, instruction, cfg, signal, cueId) {
  if (!looksLikeGatewayProfileControlIntent(instruction)) {
    return false;
  }
  const data = await runViaGateway(tabId, instruction, cfg, signal, cueId);
  if (data?.classification === "profile_control") {
    try {
      const profilePayload = await getGatewayProfile(cfg, signal);
      await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: profilePayload });
    } catch {
      // The profile-control turn already completed; cache refresh is best-effort.
    }
  }
  return true;
}

// Page tweaks are handled by tweaks.js in the content world. The trigger used to
// be a local keyword regex (looksLikePageTweak) that fired before any model turn.
// That baked-in detector is removed: the gateway model now decides when a page
// change is warranted (propose_page_tweak) and returns a page_tweak action, which
// runViaGateway applies via tweak:applyRecord. The tweak:apply/tweak:applyRecord
// message API in tweaks.js stays intact for the smoke and options paths.

function truncate(text, max) {
  const t = String(text || "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// One session id per cue. Each cue is its own conversation lane on the gateway —
// this is what lets the user keep cueing ("do X", "now Y", "also Z") and have
// each routed independently underneath instead of forced into one thread.
function sessionIdForCue(cueId) {
  return `agee_${String(cueId || "").replace(/[^a-zA-Z0-9_]/g, "") || Date.now().toString(36)}`;
}

// One stable session id for the whole conversation, persisted in
// chrome.storage.local. Conversational turns share this id so the gateway
// accumulates them under one session and the overlay can reload chat history
// across reopens. Per-cue/branch distinction is preserved via branch_id (the
// cueId), not by minting a throwaway session per message. Not a secret.
async function getStableSessionId() {
  const { ageeSessionId } = await chrome.storage.local.get("ageeSessionId");
  if (ageeSessionId) return ageeSessionId;
  const sessionId = `agee_${crypto.randomUUID()}`;
  await chrome.storage.local.set({ ageeSessionId: sessionId });
  return sessionId;
}

async function getStableDeviceId() {
  const { ageeDeviceId } = await chrome.storage.local.get("ageeDeviceId");
  if (ageeDeviceId) return ageeDeviceId;
  const deviceId = `browser_${crypto.randomUUID().replace(/-/g, "")}`;
  await chrome.storage.local.set({ ageeDeviceId: deviceId });
  return deviceId;
}

// Adopt the gateway's canonical shared session id so browser conversational
// turns land in the same session as the phone and other surfaces. The gateway
// owns the id; GET /v1/sessions/default returns it. We overwrite any locally
// minted ageeSessionId with it. On any failure (older gateway with no such
// route, network error, no id) we keep whatever local id exists. This only
// touches the conversational session id — sessionIdForCue tool-cue routing is
// left alone.
let sharedSessionAdoptInFlight = null;
async function adoptSharedGatewaySession(reason = "startup") {
  if (sharedSessionAdoptInFlight) return sharedSessionAdoptInFlight;
  sharedSessionAdoptInFlight = (async () => {
    try {
      const cfg = await getConfig();
      if (!cfg.gatewayUrl) return null;
      const data = await callGateway(cfg, "/v1/sessions/default", { method: "GET" });
      const sessionId = String(data?.session_id || "").trim();
      if (!sessionId) return null;
      const { ageeSessionId } = await chrome.storage.local.get("ageeSessionId");
      if (ageeSessionId === sessionId) return sessionId;
      await chrome.storage.local.set({ ageeSessionId: sessionId });
      return sessionId;
    } catch {
      // Older gateway or unreachable: keep the existing local id.
      return null;
    } finally {
      sharedSessionAdoptInFlight = null;
    }
  })();
  return sharedSessionAdoptInFlight;
}

// Fetch the gateway's stored copy of a voice turn by id. Used by the overlay to
// recover the assistant's real reply text when a native-audio Live turn finished
// without ever streaming assistant_text. Returns null on any failure (older
// gateway, unreachable, unknown turn) so the caller can fall back honestly.
async function fetchStoredVoiceTurn(turnId) {
  const id = String(turnId || "").trim();
  if (!id) return null;
  const cfg = await getConfig();
  if (!cfg.gatewayUrl) return null;
  const data = await callGateway(cfg, `/v1/voice/turns/${encodeURIComponent(id)}`, {
    method: "GET",
  });
  return data?.turn && typeof data.turn === "object" ? data.turn : data;
}

async function getActiveBrowserAgentOwner() {
  const stored = await chrome.storage.local.get(ACTIVE_BROWSER_AGENT_OWNER_KEY);
  return stored[ACTIVE_BROWSER_AGENT_OWNER_KEY] || null;
}

async function setActiveBrowserAgentOwner(tabId, reason = "browser agent owner changed", patch = {}) {
  if (tabId == null || !chrome?.storage?.local) return null;
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {}
  const sessionId = await getStableSessionId();
  const owner = {
    browser_session_id: sessionId,
    tab_id: tabId,
    window_id: tab?.windowId ?? patch.window_id ?? null,
    page_url: tab?.url || patch.page_url || "",
    page_title: tab?.title || patch.page_title || "",
    cue_id: patch.cue_id || patch.cueId || null,
    voice_session_id: patch.voice_session_id || patch.voiceSessionId || null,
    agent_run_id: patch.agent_run_id || patch.agentRunId || null,
    status: patch.status || "active",
    last_result: patch.last_result || patch.lastResult || "",
    reason,
    updated_at: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [ACTIVE_BROWSER_AGENT_OWNER_KEY]: owner });
  await notifyBrowserAgentOwner(owner);
  return owner;
}

async function updateActiveBrowserAgentOwner(patch = {}) {
  const owner = await getActiveBrowserAgentOwner();
  if (!owner) return null;
  const next = {
    ...owner,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [ACTIVE_BROWSER_AGENT_OWNER_KEY]: next });
  await notifyBrowserAgentOwner(next);
  return next;
}

async function updateActiveBrowserAgentOwnerFromTask(cueId, patch) {
  if (!patch || patch.tabId == null) return;
  const owner = await getActiveBrowserAgentOwner();
  if (!owner || owner.tab_id !== patch.tabId) return;
  if (owner.cue_id && cueId && owner.cue_id !== cueId) return;
  await updateActiveBrowserAgentOwner({
    cue_id: cueId || owner.cue_id || null,
    status: patch.status || owner.status || "active",
    last_result: patch.lastResult || owner.last_result || "",
  });
}

async function clearActiveBrowserAgentOwner(tabId, reason = "browser agent owner cleared") {
  const owner = await getActiveBrowserAgentOwner();
  if (!owner || (tabId != null && owner.tab_id !== tabId)) return;
  const cleared = {
    ...owner,
    status: "cleared",
    reason,
    updated_at: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [ACTIVE_BROWSER_AGENT_OWNER_KEY]: cleared });
  await notifyBrowserAgentOwner(cleared);
}

async function notifyBrowserAgentOwner(owner) {
  if (!chrome?.tabs) return;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).catch(() => []);
  await Promise.allSettled(tabs.filter((tab) => tab.id != null).map((tab) => (
    chrome.tabs.sendMessage(tab.id, {
      cmd: "browserAgentOwnerChanged",
      owner,
      isOwner: owner?.tab_id === tab.id && owner?.status !== "cleared",
    }).catch(() => {})
  )));
}

// Read the persisted conversation's ordered turns from the gateway so the
// overlay can render prior turns when it reopens. Returns [] when nothing is
// configured/stored yet (a fresh conversation simply has no history).
async function loadHistory(cfg) {
  if (!cfg.gatewayUrl) return [];
  const sessionId = await getStableSessionId();
  const data = await callGateway(cfg, `/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: "GET",
  });
  return Array.isArray(data?.turns) ? data.turns : [];
}

async function createVoiceSessionTicket(cfg, signal) {
  const sessionId = await getStableSessionId();
  const deviceId = await getStableDeviceId();
  const data = await callGateway(cfg, "/v1/voice/session-ticket", {
    signal,
    body: {
      source: "agee-extension",
      device_id: deviceId,
      session_id: sessionId,
      conversation_id: sessionId,
    },
  });
  return {
    ...data,
    session_id: sessionId,
    conversation_id: sessionId,
    device_id: deviceId,
  };
}

// Conversational turn through the user's gateway (/v1/voice/turns).
// The gateway classifies chat vs. home-machine agent runs and replies with
// display text; we render it. Page-DOM actions are a later wave.
async function runViaGateway(tabId, instruction, cfg, signal, cueId, contextControls = {}) {
  await saveTaskState(cueId, { status: "running", instruction, step: 0, lastResult: "sending to gateway", tabId });
  send(tabId, { cmd: "progress", cueId, text: "thinking…" });
  throwIfAborted(signal);

  let screen;
  try {
    const snap = await ask(tabId, { cmd: "snapshot" });
    screen = snapToScreen(snap);
  } catch {
    screen = undefined; // restricted page; send without screen context
  }

  throwIfAborted(signal);
  // Share one stable session+conversation id across turns so the gateway
  // accumulates them (and the overlay can reload them). The cueId becomes the
  // branch_id, preserving per-cue distinction without fragmenting the session.
  const sessionId = await getStableSessionId();
  const deviceId = await getStableDeviceId();
  // Explicit client thread control ("/new", "/incognito") always wins over the
  // model's own context choice. The gateway resolves context_action and returns
  // a context block; an incognito turn is answered but never persisted.
  const contextAction = String(contextControls?.contextAction || "").trim();
  const threadLabel = String(contextControls?.threadLabel || "").trim();
  const data = await callGateway(cfg, "/v1/voice/turns", {
    signal,
    body: {
      source: "agee-extension",
      device_id: deviceId,
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: cueId,
      all_branches_context: true,
      transcript: instruction,
      ...(contextAction ? { context_action: contextAction } : {}),
      ...(threadLabel ? { thread_label: threadLabel } : {}),
      client: {
        platform: "browser",
        source: "agee-extension",
        device_id: deviceId,
        input: "text",
      },
      screen,
    },
  });

  // The gateway model can now decide a page change is warranted and return it as
  // a structured action on the turn result instead of relying on a baked-in
  // keyword detector. Handle known action types here; ignore unknown ones so a
  // future gateway envelope never breaks this client.
  const tweakActionHandled = await maybeApplyTurnActions(tabId, data, signal, cueId);
  if (tweakActionHandled) {
    return data;
  }

  const reply = String(data.display || data.text || data.speak || "").trim();
  // The gateway returns a separate TTS-safe `speak` string (short, markdown-
  // stripped). Forward it so the overlay can speak the reply aloud; the gateway
  // decides when to stay silent by sending an empty speak (e.g. control turns).
  const speak = String(data.speak || "").trim();
  const runs = Array.isArray(data.agent_runs) ? data.agent_runs : [];
  let summary = reply || (runs.length ? `Started ${runs.length} agent run(s).` : "Done.");
  // An incognito turn is answered but never stored (context.persisted === false);
  // mark the visible reply. The spoken `speak` string is left clean.
  if (data?.context && data.context.persisted === false && !summary.endsWith("(not saved)")) {
    summary = `${summary}\n\n(not saved)`;
  }
  send(tabId, { cmd: "done", cueId, summary, speak });
  refreshSelfExtensionRuntime("turn_complete").catch(() => {});
  refreshUiSpec("turn_complete").catch(() => {});
  await saveTaskState(cueId, {
    status: "done",
    instruction,
    step: 1,
    tabId,
    lastResult: `[${data.classification || "chat"}] ${summary.slice(0, 400)}`,
  });
  return data;
}

// Collect structured actions off a gateway turn result. The gateway may attach a
// single `action` or an `actions` array; we accept either shape.
function turnActions(data) {
  const out = [];
  if (data && typeof data.action === "object" && data.action) out.push(data.action);
  if (data && Array.isArray(data.actions)) out.push(...data.actions.filter((a) => a && typeof a === "object"));
  return out;
}

// Execute known gateway-proposed actions from a turn. Only `page_tweak` is
// handled today: forward the pre-planned record to the content world's tweaks
// module as tweak:applyRecord, which validates and compiles it locally. Unknown
// action types are ignored silently. Returns true when a page_tweak action was
// applied and a done summary was already sent.
async function maybeApplyTurnActions(tabId, data, signal, cueId) {
  const actions = turnActions(data);
  const samplerAction = actions.find((a) => a.type === "voice_sampler");
  if (samplerAction) {
    await startVoiceSampler(tabId, cueId, samplerAction, signal);
    return true;
  }
  const tweakAction = actions.find((a) => a.type === "page_tweak" && a.record && typeof a.record === "object");
  if (!tweakAction) return false;

  send(tabId, { cmd: "progress", cueId, text: "changing this page…" });
  await saveTaskState(cueId, { status: "running", instruction: "", step: 0, lastResult: "applying page tweak", tabId });
  throwIfAborted(signal);

  let result;
  try {
    result = await ask(tabId, { cmd: "tweak:applyRecord", record: tweakAction.record });
  } catch (error) {
    send(tabId, { cmd: "error", cueId, text: `Page tweak failed: ${String(error?.message || error)}` });
    await saveTaskState(cueId, { status: "error", instruction: "", step: 1, lastResult: String(error?.message || error), tabId });
    return true;
  }

  if (!result?.ok) {
    const message = result?.error || "That page change was not a bounded tweak I can apply.";
    send(tabId, { cmd: "done", cueId, summary: message, speak: message });
    await saveTaskState(cueId, { status: "done", instruction: "", step: 1, lastResult: message, tabId });
    return true;
  }

  const tweak = result.tweak || {};
  const summary = `Changed this page — ${tweak.name || "page tweak"} is saved for ${result.origin || "this site"}.`;
  // pageTweak flag tells the overlay to offer the "Changes on this page" review
  // affordance next to this done cue.
  send(tabId, { cmd: "done", cueId, summary, speak: summary, pageTweak: true });
  await saveTaskState(cueId, {
    status: "done",
    instruction: "",
    step: 1,
    tabId,
    lastResult: summary.slice(0, 400),
    tweakId: tweak.id,
    tweakKind: tweak.kind,
  });
  return true;
}

const voiceSamplerRuntime = createVoiceSamplerRuntime({
  send,
  closeSession: closeVoiceSession,
  async startSample({ sampler, sample, sampleIndex, onSessionCreated }) {
    const session = await startVoiceSessionProxy(sampler.tabId, {
      cueId: sampler.cueId,
      turnId: `voice_sample_${Date.now().toString(36)}_${sampleIndex}`,
      capture: "none",
      autoCommit: false,
      profileOverride: { voice: sample.voice, response_modality: "speech" },
      sampleText: sample.text,
      onSessionCreated,
    });
    attachVoiceSession(session.voiceSessionId, sampler.tabId);
    return session;
  },
});

async function startVoiceSampler(tabId, cueId, action, signal) {
  const samples = parseVoiceSamplerAction(action);
  if (!samples.length) throw new Error("The gateway returned an invalid or empty voice sampler plan.");
  send(tabId, { cmd: "progress", cueId, text: `sampling 1 of ${samples.length}…` });
  await voiceSamplerRuntime.start(tabId, cueId, samples, { signal });
}

function cancelVoiceSampler(tabId, reason) {
  voiceSamplerRuntime.cancel(tabId, reason);
}

function send(tabId, msg) {
  // Panel-owned sessions are addressed with the PANEL_TAB_ID sentinel: the
  // side panel is an extension page, not a tab, so tabs.sendMessage can never
  // reach it. Route its traffic over the panel port instead.
  if (tabId === PANEL_TAB_ID) {
    sendToPanel(msg);
    return;
  }
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function ask(tabId, msg, options = undefined) {
  return options ? chrome.tabs.sendMessage(tabId, msg, options) : chrome.tabs.sendMessage(tabId, msg);
}

async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { cmd: "ping" });
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["overlay.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["ui-spec-runtime.js", "proactive-helper.js", "content.js"] });
  }
}

async function ensureContentOnOpenTabs() {
  if (!chrome?.tabs || !chrome?.scripting) return;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.allSettled(tabs.filter((tab) => tab.id != null).map((tab) => ensureContent(tab.id)));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("Task cancelled.");
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer || 0);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBuffer(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function voiceSessionId() {
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function hasOffscreenVoiceDocument() {
  if (!chrome?.offscreen) return false;
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_VOICE_DOCUMENT);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    return contexts.length > 0;
  }
  const clients = await self.clients.matchAll();
  return clients.some((client) => client.url === offscreenUrl);
}

async function ensureOffscreenVoiceDocument() {
  if (!chrome?.offscreen?.createDocument) {
    throw new Error("Extension microphone capture is not supported in this Chrome build.");
  }
  if (await hasOffscreenVoiceDocument()) return;
  if (!creatingOffscreenVoiceDocument) {
    creatingOffscreenVoiceDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_VOICE_DOCUMENT,
      reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
      justification: "A.G. captures microphone audio (voice, notes) and user-picked screen video (video notes) from the extension origin and sends them to the configured gateway.",
    }).finally(() => {
      creatingOffscreenVoiceDocument = null;
    });
  }
  await creatingOffscreenVoiceDocument;
}

function extensionMicApprovalMessage(error) {
  const detail = String(error?.message || error || "").trim();
  const suffix = detail ? ` (${detail})` : "";
  return `A.G. could not open the extension microphone. Open the A.G. toolbar icon > Options, click "Grant microphone", and allow microphone access for the extension. If Chrome has blocked it, open chrome://extensions/?id=${chrome.runtime.id}, choose Details or Site settings, set Microphone to Allow, then start voice again.${suffix}`;
}

async function startOffscreenVoiceCapture(id) {
  await ensureOffscreenVoiceDocument();
  const response = await chrome.runtime.sendMessage({
    cmd: "offscreenVoiceCaptureStart",
    voiceSessionId: id,
  });
  if (!response?.ok) throw new Error(response?.error || "extension microphone capture did not start");
}

async function stopOffscreenVoiceCapture(id) {
  if (!chrome?.offscreen) return;
  if (!(await hasOffscreenVoiceDocument())) return;
  await chrome.runtime
    .sendMessage({
      cmd: "offscreenVoiceCaptureStop",
      voiceSessionId: id || null,
    })
    .catch(() => {});
}

function handleOffscreenVoiceError(id, error) {
  const session = voiceSessions.get(id);
  if (!session) return;
  const message = extensionMicApprovalMessage(error);
  session.setupErrorMessage = message;
  chrome.runtime.openOptionsPage?.().catch(() => {});
  deliverVoiceSessionEvent(session, {
    event: {
      type: "error",
      code: "microphone_capture_failed",
      recoverable: false,
      message,
    },
  });
  closeVoiceSession(id, "microphone capture failed");
}

function claimActiveAgentTab(tabId, reason = "another page became active", patch = {}) {
  if (tabId == null) return;
  revokeProactiveGrant(tabId, "agent_started");
  const revokedTabs = new Map();

  for (const [cueId, task] of [...tasks]) {
    // Gateway-claimed background agent-loop tasks are not tab-owned foreground
    // cues; ordinary ownership changes must not abort them. Stop-intent cancels
    // them through cancelAgentLoopCues instead.
    if (task.agentLoop) continue;
    if (task.tabId === tabId) continue;
    try {
      task.controller.abort();
    } catch {}
    tasks.delete(cueId);
    if (!revokedTabs.has(task.tabId)) revokedTabs.set(task.tabId, []);
    revokedTabs.get(task.tabId).push(cueId);
  }

  for (const oldTabId of revokeOtherTabVoiceSessions(tabId, reason)) {
    if (!revokedTabs.has(oldTabId)) revokedTabs.set(oldTabId, []);
  }

  for (const [oldTabId, cueIds] of revokedTabs) {
    send(oldTabId, { cmd: "agentRevoked", cueIds, reason });
  }
  activeAgentTabId = tabId;
  setActiveBrowserAgentOwner(tabId, reason, patch).catch(() => {});
}

function revokeOtherTabVoiceSessions(tabId, reason) {
  const tabIds = new Set();
  if (activeAgentTabId != null && activeAgentTabId !== tabId) tabIds.add(activeAgentTabId);
  for (const [id, session] of [...voiceSessions]) {
    if (session.tabId === tabId) continue;
    tabIds.add(session.tabId);
    closeVoiceSession(id, reason, { revoked: true });
  }
  return tabIds;
}

// Voice-start mode switch. When the flag-gated "LiveKit voice (experimental)"
// setting is ON, try the LiveKit transport first; on ANY failure show a visible
// notice and fall back to the default WS path. When OFF (the default), this is a
// straight passthrough to the WS path, so verify/smoke stay on the WS pipeline.
async function startVoiceSessionWithMode(tabId, opts = {}) {
  // livekit-voice.js delivers straight to a tab's content script; panel
  // sessions must stay on the proxy path, whose events route through send().
  if (tabId !== PANEL_TAB_ID && await isLivekitVoiceEnabled()) {
    try {
      const cfg = await getConfig();
      const sessionId = await getStableSessionId();
      const deviceId = await getStableDeviceId();
      return await startLivekitVoiceSession({
        tabId,
        cueId: opts.cueId,
        gatewayUrl: cfg.gatewayUrl,
        gatewayToken: cfg.gatewayToken,
        sessionId,
        deviceId,
      });
    } catch (error) {
      send(tabId, {
        cmd: "livekitNotice",
        cueId: opts.cueId || null,
        text: `LiveKit voice unavailable, using standard voice (${String(error?.message || error)}).`,
      });
    }
  }
  return startVoiceSessionProxy(tabId, opts);
}

async function startVoiceSessionProxy(tabId, { cueId, turnId, assistantOverlap, capture, autoCommit, contextAction, threadLabel, profileOverride, sampleText, onSessionCreated } = {}) {
  // Hold the capture mutex across the async setup window. recordSessionStart
  // refuses while voiceStartPending > 0; by the time the mutex releases the
  // session is registered in voiceSessions (or this start has failed), so the
  // record path can never race the single offscreen capture slot.
  if (activeRecordSession()) {
    throw new Error("An audio note recording is in progress. Stop recording before starting voice.");
  }
  voiceStartPending += 1;
  try {
    return await startVoiceSessionProxyLocked(tabId, { cueId, turnId, assistantOverlap, capture, autoCommit, contextAction, threadLabel, profileOverride, sampleText, onSessionCreated });
  } finally {
    voiceStartPending = Math.max(0, voiceStartPending - 1);
  }
}

// Set the active thread for the shared session, or mint a new/fork/incognito
// branch, and return the resolved branch id. Streaming voice must do this before
// opening the WS session because the socket branch is fixed at session start.
async function switchThreadBranch(cfg, action, label) {
  const sessionId = await getStableSessionId();
  const deviceId = await getStableDeviceId();
  const data = await callGateway(cfg, "/v1/threads/switch", {
    body: {
      session_id: sessionId,
      action,
      ...(label ? { thread_label: label } : {}),
      surface: "agee-extension",
      device_id: deviceId,
    },
  });
  return String(data?.thread?.branch_id || data?.active?.branch_id || data?.branch_id || "").trim();
}

async function startVoiceSessionProxyLocked(tabId, { cueId, turnId, assistantOverlap, capture, autoCommit, contextAction, threadLabel, profileOverride, sampleText, onSessionCreated } = {}) {
  const id = voiceSessionId();
  const captureMode = capture || "content-script";
  const session = {
    id,
    tabId,
    ws: null,
    turnId,
    opened: false,
    gatewayReady: false,
    attached: false,
    pendingEvents: [],
    capture: captureMode,
    captureStarted: false,
    captureStartRequested: false,
    pendingCommitMessage: null,
    queuedAudio: [],
    queuedAudioBytes: 0,
    queuedAudioDroppedBytes: 0,
    autoCommitEnabled: autoCommit !== false && VOICE_AUTO_COMMIT_ENABLED,
    audioStartedAt: 0,
    lastSpeechAt: 0,
    speechMs: 0,
    recordingMs: 0,
    committed: false,
    autoCommitTimer: null,
    maxCommitTimer: null,
    profileOverride,
    sampleText,
  };
  voiceSessions.set(id, session);
  onSessionCreated?.(id);
  if (voiceSessions.get(id) !== session || session.closed) {
    throw new Error(session.setupErrorMessage || "Voice session closed during setup.");
  }
  if (session.capture === "extension-offscreen") {
    session.captureStartRequested = true;
    startOffscreenVoiceCapture(id)
      .then(() => {
        if (voiceSessions.get(id) === session && !session.closed) session.captureStarted = true;
      })
      .catch((error) => handleOffscreenVoiceError(id, error));
  }

  const abortSetup = (message) => {
    closeVoiceSession(id, message || "voice session setup failed");
    return new Error(message || "Voice session setup failed.");
  };

  let cfg;
  let branchForSession = cueId;
  let ticket;
  try {
    cfg = await getConfig();
    // Resolve the thread branch for an incognito / new-thread voice turn before
    // minting the ticket, so the WS session opens on the right branch. An incognito
    // switch that fails must not fall back to a persisted branch — fail the start.
    const action = String(contextAction || "").trim();
    if (action === "incognito" || action === "new" || action === "fork") {
      let resolvedBranch = "";
      try {
        resolvedBranch = await switchThreadBranch(cfg, action, String(threadLabel || "").trim());
      } catch (error) {
        if (action === "incognito") {
          throw abortSetup(`Could not start a private voice turn: ${String(error?.message || error)}`);
        }
      }
      if (resolvedBranch) {
        branchForSession = resolvedBranch;
      } else if (action === "incognito") {
        throw abortSetup("Could not start a private voice turn: the gateway did not return an incognito branch.");
      }
    }
    ticket = await createVoiceSessionTicket(cfg);
    if (voiceSessions.get(id) !== session || session.closed) {
      throw new Error(session.setupErrorMessage || "Voice session closed during setup.");
    }
    // Re-check after the awaits above: a record session that slipped in before
    // the mutex was visible must win. Abort this voice start cleanly instead of
    // stealing the microphone from the in-flight audio note.
    if (activeRecordSession()) {
      throw abortSetup("An audio note recording is in progress. Stop recording before starting voice.");
    }
    if (!ticket?.ws_url) {
      throw abortSetup(`Gateway reachable at ${cfg.gatewayUrl || "(unset)"}, but it did not return a voice session WebSocket URL.`);
    }
  } catch (error) {
    if (voiceSessions.get(id) === session) {
      closeVoiceSession(id, "voice session setup failed");
    }
    throw error;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(ticket.ws_url);
    } catch (error) {
      settled = true;
      closeVoiceSession(id, "voice socket constructor failed");
      reject(new Error(formatVoiceSocketNetworkError(cfg, ticket, String(error?.message || error))));
      return;
    }
    if (voiceSessions.get(id) !== session || session.closed) {
      settled = true;
      try {
        ws.close();
      } catch {}
      reject(new Error(session.setupErrorMessage || "Voice session closed during setup."));
      return;
    }
    session.ws = ws;
    ws.binaryType = "arraybuffer";

    const failBeforeOpen = (message, { voiceSocket = true } = {}) => {
      voiceSessions.delete(id);
      clearQueuedVoiceSessionMedia(session);
      stopOffscreenVoiceCapture(id).catch(() => {});
      try {
        ws.close();
      } catch {}
      if (!settled) {
        settled = true;
        reject(new Error(voiceSocket ? formatVoiceSocketNetworkError(cfg, ticket, message) : message));
      }
    };

    ws.onopen = () => {
      if (!voiceSessionSocketOpen(session)) {
        failBeforeOpen(session.revoked ? "Live voice session was revoked." : "Live voice connection closed.", {
          voiceSocket: !session.revoked,
        });
        return;
      }
      const started = sendVoiceSessionJson(session, {
        type: "session_start",
        source: "agee-extension",
        device_id: ticket.device_id || "",
        session_id: ticket.session_id,
        conversation_id: ticket.conversation_id || ticket.session_id,
        branch_id: branchForSession,
        turn_id: turnId,
        all_branches_context: true,
        client: {
          platform: "browser",
          source: "agee-extension",
          device_id: ticket.device_id || "",
          input: "voice",
        },
        playback_policy: {
          assistant_overlap: assistantOverlap === true,
        },
        ...(profileOverride ? { profile_override: profileOverride } : {}),
        format: {
          encoding: "pcm16",
          sample_rate: 16000,
          channels: 1,
        },
      });
      if (!started) {
        failBeforeOpen("session_start could not be sent");
        return;
      }
      session.opened = true;
      settled = true;
      resolve({
        voiceSessionId: id,
        session_id: ticket.session_id,
        conversation_id: ticket.conversation_id || ticket.session_id,
      });
    };

    ws.onmessage = (event) => forwardVoiceSessionEvent(session, event).catch(() => {});
    ws.onerror = () => {
      if (!session.opened) {
        failBeforeOpen("Live voice connection failed.");
        return;
      }
      if (voiceSamplerRuntime.handleSessionTerminal(session.id, {
        failed: true,
        message: "Live voice connection failed.",
        closeReason: "sample failed",
      })) {
        return;
      }
      deliverVoiceSessionEvent(session, {
        event: { type: "error", message: "Live voice connection failed." },
      });
    };
    ws.onclose = () => {
      if (!session.opened) {
        if (session.revoked) {
          if (!settled) {
            settled = true;
            resolve({ voiceSessionId: id, revoked: true });
          }
          session.closed = true;
          clearVoiceAutoCommit(session);
          clearQueuedVoiceSessionMedia(session);
          stopOffscreenVoiceCapture(id).catch(() => {});
          deliverVoiceSessionEvent(session, {
            event: { type: "revoked", reason: session.closedReason || "revoked" },
          });
          if (session.attached) voiceSessions.delete(id);
          else setTimeout(() => voiceSessions.delete(id), 5000);
          return;
        }
        failBeforeOpen("Live voice connection closed.");
        return;
      }
      session.closed = true;
      clearVoiceAutoCommit(session);
      clearQueuedVoiceSessionMedia(session);
      stopOffscreenVoiceCapture(id).catch(() => {});
      if (voiceSamplerRuntime.handleSessionTerminal(session.id, {
        failed: !session.revoked,
        cancelled: session.revoked,
        message: session.revoked ? "" : "Live voice connection closed.",
        closeReason: session.revoked ? session.closedReason || "revoked" : "sample failed",
      })) {
        if (session.attached) voiceSessions.delete(id);
        else setTimeout(() => voiceSessions.delete(id), 5000);
        return;
      }
      deliverVoiceSessionEvent(session, {
        event: session.revoked
          ? { type: "revoked", reason: session.closedReason || "revoked" }
          : { type: "connection_closed" },
      });
      if (session.attached) voiceSessions.delete(id);
      else setTimeout(() => voiceSessions.delete(id), 5000);
    };
  });
}

function voiceSessionSocketOpen(session) {
  return !!session
    && !session.closed
    && voiceSessions.get(session.id) === session
    && session.ws?.readyState === WebSocket.OPEN;
}

function markVoiceSessionSendFailed(session, reason = "send failed") {
  if (!session || session.closed) return;
  session.closed = true;
  session.closedReason = reason;
  voiceSessions.delete(session.id);
  clearVoiceAutoCommit(session);
  clearQueuedVoiceSessionMedia(session);
  stopOffscreenVoiceCapture(session.id).catch(() => {});
  try {
    session.ws?.close(1000, reason);
  } catch {}
}

function sendVoiceSessionJson(session, message) {
  if (!voiceSessionSocketOpen(session)) return false;
  try {
    session.ws.send(JSON.stringify(message || {}));
    return true;
  } catch {
    markVoiceSessionSendFailed(session);
    return false;
  }
}

function sendVoiceSessionBinary(session, buffer) {
  if (!voiceSessionSocketOpen(session)) return false;
  try {
    session.ws.send(buffer);
    return true;
  } catch {
    markVoiceSessionSendFailed(session);
    return false;
  }
}

function queueVoiceSessionAudio(session, buffer) {
  if (!session || session.closed || !buffer?.byteLength) return false;
  session.queuedAudio ||= [];
  session.queuedAudioBytes = (session.queuedAudioBytes || 0) + buffer.byteLength;
  session.queuedAudio.push(buffer);
  while (session.queuedAudioBytes > MAX_QUEUED_VOICE_AUDIO_BYTES && session.queuedAudio.length > 1) {
    const dropped = session.queuedAudio.shift();
    session.queuedAudioBytes -= dropped?.byteLength || 0;
    session.queuedAudioDroppedBytes = (session.queuedAudioDroppedBytes || 0) + (dropped?.byteLength || 0);
  }
  return true;
}

function flushQueuedVoiceSessionAudio(session) {
  if (!session?.queuedAudio?.length || !voiceSessionSocketOpen(session) || !session.gatewayReady) return false;
  const queued = session.queuedAudio;
  session.queuedAudio = [];
  session.queuedAudioBytes = 0;
  for (const buffer of queued) {
    if (!sendVoiceSessionBinary(session, buffer)) {
      queueVoiceSessionAudio(session, buffer);
      return false;
    }
  }
  return true;
}

function sendOrQueueVoiceSessionCommit(session, message) {
  if (!session || session.closed) return false;
  if (!voiceSessionSocketOpen(session) || !session.gatewayReady) {
    session.pendingCommitMessage = message || {};
    return true;
  }
  if (session.queuedAudio?.length && !flushQueuedVoiceSessionAudio(session)) return false;
  const pending = session.pendingCommitMessage || message || {};
  session.pendingCommitMessage = null;
  return sendVoiceSessionJson(session, pending);
}

function flushQueuedVoiceSessionMedia(session) {
  if (!session || !session.gatewayReady) return;
  flushQueuedVoiceSessionAudio(session);
  if (session.pendingCommitMessage && !session.queuedAudio?.length) {
    const pending = session.pendingCommitMessage;
    session.pendingCommitMessage = null;
    sendVoiceSessionJson(session, pending);
  }
}

function clearQueuedVoiceSessionMedia(session) {
  if (!session) return;
  session.pendingCommitMessage = null;
  session.queuedAudio = [];
  session.queuedAudioBytes = 0;
}

function deliverVoiceSessionEvent(session, payload) {
  if (!session) return;
  const message = { cmd: "voiceSessionEvent", voiceSessionId: session.id, ...payload };
  if (!session.attached) {
    session.pendingEvents = session.pendingEvents || [];
    session.pendingEvents.push(message);
    if (session.pendingEvents.length > MAX_PENDING_VOICE_EVENTS) session.pendingEvents.shift();
    return;
  }
  send(session.tabId, message);
}

function attachVoiceSession(id, tabId) {
  const session = voiceSessions.get(id);
  if (!session || session.tabId !== tabId) return { ok: false, error: "voice session not found" };
  session.attached = true;
  const pendingEvents = session.pendingEvents || [];
  session.pendingEvents = [];
  for (const event of pendingEvents) send(session.tabId, event);
  if (session.closed) voiceSessions.delete(id);
  return { ok: true, flushed: pendingEvents.length };
}

async function forwardVoiceSessionEvent(session, event) {
  if (!voiceSessions.has(session.id)) return;
  const data = event.data;
  if (data instanceof ArrayBuffer) {
    deliverVoiceSessionEvent(session, { audio: bytesToBase64(data) });
    return;
  }
  if (data instanceof Blob) {
    const buffer = await data.arrayBuffer();
    deliverVoiceSessionEvent(session, { audio: bytesToBase64(buffer) });
    return;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(String(data || "{}"));
  } catch {}
  if (parsed?.type === "session_ready") {
    session.gatewayReady = true;
    if (session.sampleText) {
      sendVoiceSessionJson(session, { type: "text_turn", text: session.sampleText, turn_id: session.turnId });
    }
    flushQueuedVoiceSessionMedia(session);
    if (session.capture === "extension-offscreen" && !session.captureStarted && !session.captureStartRequested) {
      session.captureStartRequested = true;
      startOffscreenVoiceCapture(session.id)
        .then(() => {
          if (voiceSessions.get(session.id) === session && !session.closed) session.captureStarted = true;
        })
        .catch((error) => handleOffscreenVoiceError(session.id, error));
    }
  }
  if (parsed?.type === "turn_done" || parsed?.type === "error" || String(parsed?.status || "").toLowerCase() === "error") {
    const failed = parsed?.type === "error" || String(parsed?.status || "").toLowerCase() === "error";
    if (voiceSamplerRuntime.handleSessionTerminal(session.id, { failed, closeReason: failed ? "sample failed" : "sample complete" })) {
      return;
    }
  }
  if (parsed?.type === "error") {
    deliverVoiceSessionEvent(session, { event: parsed });
    return;
  }
  if (parsed?.type === "turn_progress") {
    // Keepalive the gateway emits every ~5s between commit and turn_done. Route it
    // to the content script exactly like assistant_text / turn_done (the generic
    // relay below) so the client's post-commit response watchdog resets on it and
    // any future UI can read parsed.stage. Delivered here and returned so the
    // generic forward does not double-send it.
    deliverVoiceSessionEvent(session, { event: parsed });
    return;
  }
  deliverVoiceSessionEvent(session, {
    event: parsed || { type: "raw", data: String(data || "") },
  });
}

function sendVoiceSessionAudio(id, audio) {
  const session = voiceSessions.get(id);
  if (!session || session.closed || voiceSessions.get(session.id) !== session) {
    return { ok: false, error: "voice session is not open" };
  }
  const buffer = base64ToBuffer(audio);
  noteVoiceSessionAudio(session, buffer);
  if (!voiceSessionSocketOpen(session) || !session.gatewayReady) {
    return queueVoiceSessionAudio(session, buffer)
      ? { ok: true, queued: true, queuedBytes: session.queuedAudioBytes || 0 }
      : { ok: false, error: "voice session is not open" };
  }
  if (session.queuedAudio?.length) flushQueuedVoiceSessionAudio(session);
  if (!sendVoiceSessionBinary(session, buffer)) return { ok: false, error: "voice session is not open" };
  return { ok: true };
}

async function sendVoiceSessionControl(id, message) {
  const session = voiceSessions.get(id);
  if (!session || session.closed || voiceSessions.get(session.id) !== session) {
    return { ok: false, error: "voice session is not open" };
  }
  if (message?.type === "commit_turn" || message?.type === "cancel_turn") {
    session.committed = true;
    clearVoiceAutoCommit(session);
    await stopOffscreenVoiceCapture(id);
  }
  if (message?.type === "commit_turn") {
    if (!sendOrQueueVoiceSessionCommit(session, message || {})) return { ok: false, error: "voice session is not open" };
    return { ok: true, queued: session.pendingCommitMessage === message };
  }
  if (message?.type === "cancel_turn") {
    clearQueuedVoiceSessionMedia(session);
  }
  if (!voiceSessionSocketOpen(session)) return { ok: false, error: "voice session is not open" };
  if (session.gatewayReady && session.queuedAudio?.length) flushQueuedVoiceSessionAudio(session);
  if (!sendVoiceSessionJson(session, message || {})) return { ok: false, error: "voice session is not open" };
  return { ok: true };
}

function closeVoiceSession(id, reason = "closed", { revoked = false } = {}) {
  const session = voiceSessions.get(id);
  if (!session) return;
  session.closed = true;
  session.closedReason = reason;
  session.revoked = revoked === true;
  voiceSessions.delete(id);
  clearVoiceAutoCommit(session);
  clearQueuedVoiceSessionMedia(session);
  stopOffscreenVoiceCapture(id).catch(() => {});
  try {
    session.ws?.close(1000, reason);
  } catch {}
}

function noteVoiceSessionAudio(session, buffer) {
  if (!session?.autoCommitEnabled || session.committed || !buffer?.byteLength) return;
  const now = Date.now();
  const durationMs = Math.max(1, Math.round((buffer.byteLength / 2 / 16000) * 1000));
  session.audioStartedAt ||= now;
  session.recordingMs = (session.recordingMs || 0) + durationMs;
  const activity = pcm16VoiceActivity(buffer);
  if (activity.speech) {
    session.lastSpeechAt = now;
    session.speechMs = (session.speechMs || 0) + durationMs;
  }
  if (
    !activity.speech &&
    session.lastSpeechAt &&
    (session.speechMs || 0) >= VOICE_AUTO_COMMIT_MIN_SPEECH_MS &&
    now - session.lastSpeechAt >= VOICE_AUTO_COMMIT_SILENCE_MS
  ) {
    autoCommitVoiceSession(session.id, "silence audio").catch(() => {});
    return;
  }
  if (session.lastSpeechAt) {
    scheduleVoiceAutoCommit(session, VOICE_AUTO_COMMIT_SILENCE_MS);
  }
  if (session.lastSpeechAt && !session.maxCommitTimer) {
    session.maxCommitTimer = setTimeout(() => {
      autoCommitVoiceSession(session.id, "stuck-VAD backstop reached").catch(() => {});
    }, VOICE_STUCK_VAD_BACKSTOP_MS);
  }
}

function pcm16VoiceActivity(buffer) {
  const view = new DataView(buffer);
  const samples = Math.floor(buffer.byteLength / 2);
  if (!samples) return { speech: false, rms: 0, peak: 0 };
  let sumSquares = 0;
  let peak = 0;
  for (let offset = 0; offset + 1 < buffer.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true) / 32768;
    const abs = Math.abs(sample);
    sumSquares += sample * sample;
    if (abs > peak) peak = abs;
  }
  const rms = Math.sqrt(sumSquares / samples);
  return {
    speech: rms >= VOICE_ACTIVITY_RMS_THRESHOLD || peak >= VOICE_ACTIVITY_PEAK_THRESHOLD,
    rms,
    peak,
  };
}

function scheduleVoiceAutoCommit(session, delayMs) {
  if (!session || session.committed) return;
  if (session.autoCommitTimer) clearTimeout(session.autoCommitTimer);
  session.autoCommitTimer = setTimeout(() => {
    autoCommitVoiceSession(session.id, "silence after speech").catch(() => {});
  }, Math.max(120, delayMs));
}

async function autoCommitVoiceSession(id, reason) {
  const session = voiceSessions.get(id);
  if (!session || session.committed || !voiceSessionSocketOpen(session)) return;
  if (!session.lastSpeechAt || (session.speechMs || 0) < VOICE_AUTO_COMMIT_MIN_SPEECH_MS) {
    scheduleVoiceAutoCommit(session, VOICE_AUTO_COMMIT_SILENCE_MS);
    return;
  }
  const silenceMs = Date.now() - session.lastSpeechAt;
  if (reason !== "max recording reached" && silenceMs < VOICE_AUTO_COMMIT_SILENCE_MS) {
    scheduleVoiceAutoCommit(session, VOICE_AUTO_COMMIT_SILENCE_MS - silenceMs);
    return;
  }
  await sendVoiceSessionControl(id, {
    type: "commit_turn",
    turn_id: session.turnId,
    reason: `browser_auto_commit:${reason}`,
  });
}

function clearVoiceAutoCommit(session) {
  if (!session) return;
  if (session.autoCommitTimer) clearTimeout(session.autoCommitTimer);
  if (session.maxCommitTimer) clearTimeout(session.maxCommitTimer);
  session.autoCommitTimer = null;
  session.maxCommitTimer = null;
}

function closeTabVoiceSessions(tabId) {
  for (const session of voiceSessions.values()) {
    if (session.tabId === tabId) closeVoiceSession(session.id, "tab closed");
  }
}

// ---- Record mode: raw audio notes -----------------------------------------
// Record mode is an audio_note capture, not a voice turn. It reuses the
// offscreen PCM16 microphone capture with a record-scoped id, buffers the raw
// bytes in memory, and posts them to /v1/audio-notes on stop. This path never
// opens a gateway voice socket, so no STT, LLM, or TTS can run by construction.
function recordSessionKey() {
  return `record:${crypto.randomUUID()}`;
}

function isRecordSessionId(id) {
  return typeof id === "string" && id.startsWith("record:");
}

function activeRecordSession() {
  for (const session of recordSessions.values()) {
    if (!session.closed) return session;
  }
  return null;
}

function appendRecordSessionAudio(id, audio) {
  const session = recordSessions.get(id);
  if (!session || session.closed) return { ok: false, error: "record session is not open" };
  if (session.capped) return { ok: true, capped: true, totalBytes: session.totalBytes };
  const buffer = base64ToBuffer(audio);
  if (!buffer.byteLength) return { ok: true, totalBytes: session.totalBytes };
  // Cap-aware append: take only the room left, so the ~5 minute cap is exact
  // instead of overshooting by up to one chunk. room stays PCM16-aligned
  // because the cap and every chunk length are even byte counts.
  const room = RECORD_MAX_AUDIO_BYTES - session.totalBytes;
  const bytes = new Uint8Array(buffer);
  const take = bytes.byteLength <= room ? bytes : bytes.subarray(0, room);
  if (take.byteLength > 0) {
    session.chunks.push(take);
    session.totalBytes += take.byteLength;
  }
  if (session.totalBytes >= RECORD_MAX_AUDIO_BYTES) {
    // Hit the cap: keep what we have and stop pulling microphone audio. The
    // note is stored when the user presses stop.
    session.capped = true;
    stopOffscreenVoiceCapture(id).catch(() => {});
  }
  return { ok: true, totalBytes: session.totalBytes, capped: session.capped === true };
}

function discardRecordSession(id, _reason = "discarded") {
  const session = recordSessions.get(id);
  if (!session) return;
  session.closed = true;
  recordSessions.delete(id);
  session.chunks = [];
  stopOffscreenVoiceCapture(id).catch(() => {});
}

function closeTabRecordSessions(tabId) {
  for (const session of [...recordSessions.values()]) {
    if (session.tabId === tabId) discardRecordSession(session.id, "tab closed");
  }
}

async function startRecordSession(tabId) {
  // The offscreen document has a single capture slot, so a record session and
  // a voice session must never run at once. Refuse instead of tearing down the
  // live voice turn under the user. voiceStartPending covers the async setup
  // window before a starting voice session appears in voiceSessions.
  if (voiceStartPending > 0 || voiceSessions.size > 0) {
    return { ok: false, error: "A voice session is active. Stop voice before recording a note." };
  }
  if (activeRecordSession()) {
    return { ok: false, error: "A recording is already in progress." };
  }
  if (videoNoteSession) {
    return { ok: false, error: "A video note recording is in progress. Stop it before recording an audio note." };
  }
  const id = recordSessionKey();
  const session = {
    id,
    tabId: tabId ?? null,
    chunks: [],
    totalBytes: 0,
    capped: false,
    closed: false,
    startedAt: Date.now(),
  };
  recordSessions.set(id, session);
  try {
    await startOffscreenVoiceCapture(id);
  } catch (error) {
    recordSessions.delete(id);
    return { ok: false, error: extensionMicApprovalMessage(error) };
  }
  return { ok: true, recordSessionId: id };
}

async function stopRecordSession() {
  const session = activeRecordSession();
  if (!session) {
    return { stored: false, error: "No recording is in progress." };
  }
  session.closed = true;
  recordSessions.delete(session.id);
  await stopOffscreenVoiceCapture(session.id).catch(() => {});
  const pcm = concatRecordSessionAudio(session);
  if (!pcm.byteLength) {
    return { stored: false, error: "No audio was captured." };
  }
  const durationMs = Math.round((pcm.byteLength / 2 / 16000) * 1000);
  try {
    const cfg = await getConfig();
    const payload = await uploadAudioNote(cfg, pcm, durationMs);
    return { stored: true, note: payload?.note || payload || null, durationMs };
  } catch (error) {
    return { stored: false, error: String(error?.message || error), durationMs };
  }
}

function concatRecordSessionAudio(session) {
  const out = new Uint8Array(session.totalBytes);
  let offset = 0;
  for (const chunk of session.chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  session.chunks = [];
  return out;
}

// Raw-body upload. callGateway always JSON-encodes its body, so audio notes
// post through their own fetch with the same auth and error shaping.
async function uploadAudioNote(cfg, pcmBytes, durationMs) {
  if (!cfg.gatewayUrl) {
    throw new Error("No gateway URL set. Open A.G. Options and set the Agent gateway URL.");
  }
  const path = "/v1/audio-notes";
  const sessionId = await getStableSessionId();
  const headers = {
    "content-type": "audio/L16; rate=16000; channels=1",
    "x-moa-surface": "agee-extension",
    "x-moa-session-id": sessionId,
    "x-moa-duration-ms": String(durationMs),
  };
  if (cfg.gatewayToken) headers.authorization = `Bearer ${cfg.gatewayToken}`;
  let resp;
  try {
    resp = await fetch(`${cfg.gatewayUrl}${path}`, { method: "POST", headers, body: pcmBytes });
  } catch (error) {
    throw new Error(formatGatewayNetworkError(cfg.gatewayUrl, path, error));
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(formatGatewayHttpError(cfg, path, resp, text));
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Any 2xx counts as stored even if the gateway envelope is not JSON.
    return null;
  }
}
// ---- End record mode -------------------------------------------------------

// ---- Video notes: screen recording + narration → gateway video turn --------
// A video note is a screen recording with spoken narration: the user shows and
// tells what they mean, the blob is stored via /v1/video-notes, then a normal
// /v1/voice/turns request references it (video_note_id) so Gemini watches the
// recording and the reply flows back through the existing cue surface. The
// offscreen document owns capture and upload; this file owns session state,
// the desktopCapture picker, and the turn.

function chooseDesktopMediaStreamId(tab) {
  return new Promise((resolve, reject) => {
    if (!chrome.desktopCapture?.chooseDesktopMedia) {
      reject(new Error("Screen capture is not supported in this Chrome build."));
      return;
    }
    try {
      chrome.desktopCapture.chooseDesktopMedia(["screen", "window", "tab"], tab, (streamId) => {
        if (!streamId) {
          reject(new Error("Screen selection was cancelled."));
          return;
        }
        resolve(streamId);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function startVideoNoteSession(tabId) {
  if (voiceStartPending > 0 || voiceSessions.size > 0) {
    return { ok: false, error: "A voice session is active. Stop voice before recording a video note." };
  }
  if (activeRecordSession()) {
    return { ok: false, error: "An audio note recording is in progress. Stop it before recording a video note." };
  }
  if (videoNoteSession) {
    return { ok: false, error: "A video recording is already in progress." };
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: "Could not resolve the current tab for screen capture." };
  }
  const id = `video:${crypto.randomUUID()}`;
  let streamId;
  try {
    streamId = await chooseDesktopMediaStreamId(tab);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
  try {
    await ensureOffscreenVoiceDocument();
    const response = await chrome.runtime.sendMessage({
      cmd: "offscreenVideoCaptureStart",
      videoSessionId: id,
      streamId,
      maxMs: VIDEO_NOTE_MAX_MS,
      maxBytes: VIDEO_NOTE_MAX_BYTES,
    });
    if (!response?.ok) {
      return { ok: false, error: response?.error || extensionMicApprovalMessage("video capture did not start") };
    }
  } catch (error) {
    return { ok: false, error: extensionMicApprovalMessage(error) };
  }
  videoNoteSession = { id, tabId, startedAt: Date.now() };
  return { ok: true, videoSessionId: id };
}

async function stopVideoNoteSession(tabId, cueId) {
  const session = videoNoteSession;
  if (!session) {
    return { stored: false, error: "No video recording is in progress." };
  }
  videoNoteSession = null;
  let cfg;
  try {
    cfg = await getConfig();
  } catch (error) {
    return { stored: false, error: String(error?.message || error) };
  }
  const sessionId = await getStableSessionId();
  const result = await chrome.runtime
    .sendMessage({
      cmd: "offscreenVideoCaptureStop",
      videoSessionId: session.id,
      gatewayUrl: cfg.gatewayUrl,
      gatewayToken: cfg.gatewayToken,
      sessionId,
    })
    .catch((error) => ({ stored: false, error: String(error?.message || error) }));
  if (result?.stored && result.note?.id) {
    // The reply comes back on the same cue via progress/done messages; the
    // stop response only confirms the note was stored.
    runVideoNoteTurn(session.tabId ?? tabId, cueId, result.note).catch((error) => {
      send(session.tabId ?? tabId, {
        cmd: "error",
        cueId,
        text: `Video note turn failed: ${String(error?.message || error)}`,
      });
    });
  }
  return result || { stored: false, error: "Video capture did not respond." };
}

function discardVideoNoteSession(_reason = "discarded") {
  const session = videoNoteSession;
  if (!session) return;
  videoNoteSession = null;
  chrome.runtime
    .sendMessage({ cmd: "offscreenVideoCaptureDiscard", videoSessionId: session.id })
    .catch(() => {});
}

// Send the stored note through the normal conversational turn path with
// video_note_id attached. The gateway watches the recording (narration rides
// the video's audio track) and replies like any other turn.
async function runVideoNoteTurn(tabId, cueId, note) {
  const cfg = await getConfig();
  send(tabId, { cmd: "progress", cueId, text: "watching your video…" });
  const sessionId = await getStableSessionId();
  const deviceId = await getStableDeviceId();
  const data = await callGateway(cfg, "/v1/voice/turns", {
    body: {
      source: "agee-extension",
      device_id: deviceId,
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: cueId,
      all_branches_context: true,
      video_note_id: note.id,
      client: {
        platform: "browser",
        source: "agee-extension",
        device_id: deviceId,
        input: "video",
      },
    },
  });
  const reply = String(data.display || data.text || data.speak || "").trim();
  const speak = String(data.speak || "").trim();
  send(tabId, { cmd: "done", cueId, summary: reply || "Done.", speak });
  return data;
}
// ---- End video notes --------------------------------------------------------

// Persist per-cue state (keyed by cueId) so concurrent cues don't clobber each
// other. Falls back to a synthetic key when no id is given.
async function saveTaskState(id, patch) {
  const key = `ageeCue:${id || "default"}`;
  const previous = (await chrome.storage.local.get(key))[key] || {};
  await chrome.storage.local.set({
    [key]: {
      ...previous,
      ...patch,
      cueId: id,
      updatedAt: new Date().toISOString(),
    },
  });
  await updateActiveBrowserAgentOwnerFromTask(id, patch).catch(() => {});
}

async function captureScreenshot(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 45 });
    const base64 = dataUrl.split(",")[1]; // strip data: prefix
    if (base64) return base64;
  } catch {
    // Headless Chrome and some tab states reject captureVisibleTab. Fall back to
    // a short-lived CDP attach so page-agent evidence can still include pixels.
  }
  return captureScreenshotViaDebugger(tabId);
}

async function captureScreenshotViaDebugger(tabId) {
  const target = { tabId };
  let attached = false;
  try {
    await debuggerAttach(target);
    attached = true;
    await debuggerSend(target, "Page.enable");
    const shot = await debuggerSend(target, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 45,
      fromSurface: true,
    });
    return shot?.data || null;
  } catch {
    return null;
  } finally {
    if (attached) await debuggerDetach(target);
  }
}

function browserScreenshotEvidence(base64) {
  const data = String(base64 || "");
  if (!data) return null;
  const bytes = Math.ceil((data.length * 3) / 4);
  if (data.length > MAX_BROWSER_EVIDENCE_SCREENSHOT_BASE64_CHARS) {
    return {
      media_type: "image/jpeg",
      encoding: "omitted",
      omitted: true,
      bytes,
      max_base64_chars: MAX_BROWSER_EVIDENCE_SCREENSHOT_BASE64_CHARS,
      reason: "screenshot too large for gateway evidence payload",
    };
  }
  return {
    media_type: "image/jpeg",
    encoding: "base64",
    data,
    bytes,
  };
}

function elementsText(snap) {
  const lines = (snap.elements || []).slice(0, MAX_ELEMENTS).map((e) => `[${e.i}] <${e.tag}${e.type ? " " + e.type : ""}> ${e.label}`);
  const pageText = truncate(String(snap.pageText || snap.page_text || "").trim(), 2800);
  return [
    `URL: ${snap.url}`,
    `TITLE: ${snap.title}`,
    pageText ? `VISIBLE PAGE TEXT:\n${pageText}` : "",
    `INTERACTABLE ELEMENTS:\n${lines.join("\n") || "(none found)"}`,
  ].filter(Boolean).join("\n");
}

async function snapshotBlocks(tabId, signal) {
  throwIfAborted(signal);
  const snap = await ask(tabId, { cmd: "snapshot" });
  const blocks = [{ type: "text", text: elementsText(snap) }];
  throwIfAborted(signal);
  const shot = await captureScreenshot(tabId);
  if (shot) blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: shot } });
  return blocks;
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 8000);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 400);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function confirmNavigation(tabId, url) {
  const tab = await chrome.tabs.get(tabId);
  const from = tab.url ? new URL(tab.url).origin : "";
  const to = url.origin;
  if (from === to) return true;
  try {
    const response = await ask(tabId, {
      cmd: "confirm",
      text: `Allow A.G. to navigate from ${from || "this page"} to ${to}?`,
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function executeAction(tabId, input, signal) {
  throwIfAborted(signal);
  if (input.action === "navigate" && input.url) {
    let url;
    try {
      url = new URL(input.url);
    } catch {
      return `blocked invalid URL: ${input.url}`;
    }
    if (!ALLOWED_NAVIGATION_PROTOCOLS.has(url.protocol)) {
      return `blocked navigation to ${url.protocol}`;
    }
    if (!(await confirmNavigation(tabId, url))) {
      return `user cancelled navigation to ${url.origin}`;
    }
    throwIfAborted(signal);
    await chrome.tabs.update(tabId, { url: url.href });
    await waitForLoad(tabId);
    return "navigated";
  }
  if (input.action === "wait") {
    await new Promise((r) => setTimeout(r, 1000));
    return "waited";
  }
  let result;
  try {
    result = await ask(tabId, { cmd: "act", ...input });
  } catch {
    // Page likely navigated and tore down the content script.
    await waitForLoad(tabId);
    return "action sent; page navigated";
  }
  // Settle: clicks/typing may trigger navigation or async updates.
  await new Promise((r) => setTimeout(r, 700));
  return (result && result.result) || "done";
}

// Map a page snapshot into the gateway's screen-context shape so the same
// home-machine context format works for browser and Android surfaces.
function snapToScreen(snap) {
  const nodes = (snap.elements || []).slice(0, MAX_ELEMENTS).map((e) => ({
    text: e.label,
    clickable: true,
  }));
  return {
    available: true,
    package: snap.url || "",
    class: snap.title || "",
    summary: elementsText(snap),
    nodes,
  };
}

function sendBrowserAgentProgress(tabId, cueId, state, text) {
  const label = text || BROWSER_AGENT_PROGRESS_TEXT[state] || String(state || "working");
  send(tabId, { cmd: "browserAgentProgress", cueId, state, text: label });
}

async function noteBrowserAgentProgress(tabId, cueId, instruction, step, state, text) {
  const label = text || BROWSER_AGENT_PROGRESS_TEXT[state] || String(state || "working");
  sendBrowserAgentProgress(tabId, cueId, state, label);
  await saveTaskState(cueId, {
    status: state === "error" ? "error" : state === "done" ? "done" : "running",
    instruction,
    step,
    tabId,
    lastResult: label,
  });
}

async function collectBrowserSnapshot(tabId) {
  try {
    return normalizeBrowserSnapshot(await ask(tabId, { cmd: "snapshot" }));
  } catch {
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {}
    return normalizeBrowserSnapshot({
      url: tab?.url || "",
      title: tab?.title || "",
      pageText: "",
      elements: [],
    });
  }
}

async function runBrowserAgentTurn(tabId, instruction, cfg, signal, cueId, options = {}) {
  const text = String(instruction || "").trim() || "Describe this page";
  const inputKind = options.input || "text";
  const role = normalizeBrowserAgentRole(options.role);
  claimActiveAgentTab(tabId, "browser agent turn started", {
    cue_id: cueId,
    status: "collecting_page_context",
  });

  await noteBrowserAgentProgress(tabId, cueId, text, 0, "collecting_page_context");
  throwIfAborted(signal);
  const snapshot = await collectBrowserSnapshot(tabId);

  await noteBrowserAgentProgress(tabId, cueId, text, 1, "capturing_screenshot");
  throwIfAborted(signal);
  const screenshot = await captureScreenshot(tabId);
  const screenshotEvidence = browserScreenshotEvidence(screenshot);
  const inlineEvidence = browserInlineEvidence(snapshot, screenshotEvidence);
  const delegationEnvelope = role === "delegate" && options.delegationConfirmed === true
    ? browserDelegationEnvelope(text, snapshot.url)
    : null;

  const sessionId = await getStableSessionId();
  const deviceId = await getStableDeviceId();
  const client = browserTurnClient(deviceId, inputKind);
  const common = {
    source: "agee-extension",
    device_id: deviceId,
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: cueId || "browser-agent",
    all_branches_context: true,
    client,
  };

  await noteBrowserAgentProgress(tabId, cueId, text, 2, "sending_to_gateway");
  throwIfAborted(signal);
  let started = await callGateway(cfg, "/v1/browser/turns", {
    signal,
    body: {
      ...common,
      instruction: text,
      transcript: text,
      modality: inputKind,
      input: { type: inputKind, text },
      page: browserEvidencePage(snapshot),
      ...inlineEvidence,
      intent_hint: "browser_page_question",
      ...(role ? { role } : {}),
      ...(delegationEnvelope ? { delegation_envelope: delegationEnvelope } : {}),
    },
  });

  await noteBrowserAgentProgress(tabId, cueId, text, 3, "waiting_for_answer");
  throwIfAborted(signal);
  let evidenceId = "";
  if (browserTurnNeedsEvidence(started)) {
    const evidenceRequestId = browserTurnEvidenceRequestId(started);
    const evidence = await callGateway(cfg, "/v1/browser/evidence", {
      signal,
      body: {
        ...common,
        turn_id: browserTurnId(started),
        evidence_request_id: evidenceRequestId,
        instruction: text,
        page: browserEvidencePage(snapshot),
        ...inlineEvidence,
        screen: snapToScreen(snapshot),
      },
    });
    evidenceId = evidence?.evidence?.id || evidence?.evidence_id || evidence?.id || evidence?.ref || snapshot.snapshotId;
    started = evidence;
  }

  const data = await waitForBrowserTurnAnswer(cfg, started, signal);
  const summary = browserTurnSummary(data);
  const speak = String(data?.speak || data?.result?.speak || "").trim();
  if (options.delivery !== "return") {
    sendBrowserAgentProgress(tabId, cueId, "done");
    send(tabId, { cmd: "done", cueId, summary, speak });
  }
  await saveTaskState(cueId, {
    status: "done",
    instruction: text,
    step: 4,
    tabId,
    browserTurnId: browserTurnId(data) || browserTurnId(started) || null,
    evidenceId: evidenceId || null,
    agentRole: role || null,
    lastResult: summary.slice(0, 500),
  });
  return data;
}

async function waitForBrowserTurnAnswer(cfg, initial, signal) {
  if (!browserTurnIsPending(initial) || !browserTurnStatusPath(initial)) return initial || {};
  const statusPath = browserTurnStatusPath(initial);
  const deadline = Date.now() + BROWSER_TURN_STATUS_TIMEOUT_MS;
  let last = initial;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    await new Promise((resolve) => setTimeout(resolve, BROWSER_TURN_STATUS_POLL_MS));
    last = await callGateway(cfg, statusPath, { method: "GET", signal });
    if (browserTurnFailed(last)) {
      throw new Error(browserTurnReplyText(last) || last?.error || "browser turn failed");
    }
    if (!browserTurnIsPending(last)) return last || {};
  }
  throw new Error(`browser turn ${browserTurnId(initial) || ""} did not finish in time`.trim());
}

async function describePage(tabId, controller, cueId) {
  const signal = controller.signal;

  try {
    const cfg = await getConfig();

    // Thin client: page description is produced by the user's gateway. There is
    // no in-browser model path.
    if (!cfg.gatewayUrl) {
      send(tabId, { cmd: "error", cueId, text: "No gateway URL set. Click the A.G. toolbar icon → Options and set the Agent gateway URL." });
      return;
    }
    await runBrowserAgentTurn(
      tabId,
      "Describe this page in 3-5 compact bullets. Include what it is and what the user can do here. Do not claim you took any action.",
      cfg,
      signal,
      cueId,
      { input: "text" },
    );
  } catch (err) {
    const message = signal.aborted ? "Task cancelled." : String(err.message || err);
    send(tabId, { cmd: signal.aborted ? "done" : "error", cueId, summary: message, text: message });
    await saveTaskState(cueId, { status: signal.aborted ? "cancelled" : "error", instruction: "Describe this page", lastResult: message, tabId });
  } finally {
    if (tasks.get(cueId)?.controller === controller) tasks.delete(cueId);
  }
}

async function runAgent(tabId, instruction, controller, cueId, contextControls = {}) {
  const signal = controller.signal;

  try {
    const cfg = await getConfig();

    // Thin client: every turn is handled by the user's self-hosted gateway.
    // There is no in-browser model path or provider key.
    if (!cfg.gatewayUrl) {
      send(tabId, { cmd: "error", cueId, text: "No gateway URL set. Click the A.G. toolbar icon → Options and set the Agent gateway URL." });
      return;
    }

    // First, see if the user is asking *about* their prompt history, then if
    // they are changing settings by talking to the agent ("be terser", "set
    // the system prompt to …"). Either is handled through the profile
    // endpoints instead of running a conversational turn.
    // Fast local stop path, defense in depth. The overlay already halts typed
    // "stop / shut up / be quiet" before it reaches here, but if a stop utterance
    // ever arrives as a run it must halt silently and never touch a model. Tell
    // the overlay to stop playback and live turns; do not produce a reply.
    if (isStopCommand(instruction)) {
      send(tabId, { cmd: "stop", cueId });
      // A spoken/typed stop also halts any autonomous background agent-loop.
      cancelAgentLoopCues();
      send(tabId, { cmd: "done", cueId, summary: "", text: "" });
      return;
    }
    if (await maybeAnswerProfileQuery(tabId, instruction, cfg, signal, cueId)) {
      return;
    }
    if (await maybeRouteGatewayProfileControl(tabId, instruction, cfg, signal, cueId)) {
      return;
    }
    if (await maybeApplySettingsChange(tabId, instruction, cfg, signal, cueId)) {
      return;
    }
    if (await maybeRequestAndroidSpeak(tabId, instruction, cfg, signal, cueId)) {
      return;
    }
    const explicitRole = normalizeBrowserAgentRole(contextControls.agentRole);
    if (explicitRole) {
      await runBrowserAgentTurn(tabId, instruction, cfg, signal, cueId, {
        input: "text",
        role: explicitRole,
        delegationConfirmed: contextControls.delegationConfirmed === true,
      });
      return;
    }
    // Page-change requests are no longer gated by a local keyword regex. They flow
    // to the gateway model turn, which can call propose_page_tweak and return a
    // page_tweak action; runViaGateway applies it through tweak:applyRecord. The
    // tweak:* message API stays intact for the smoke and options paths.
    const browserTask = parseBrowserTaskIntent(instruction);
    if (browserTask) {
      await runBranchTaskAgent(tabId, browserTask.instruction, browserTask.url, controller, cueId);
      return;
    }
    if (await maybeOpenRequestedTab(tabId, instruction, signal, cueId)) {
      return;
    }
    if (looksLikePageContextQuestion(instruction)) {
      await runBrowserAgentTurn(tabId, instruction, cfg, signal, cueId, { input: "text" });
      return;
    }
    await runViaGateway(tabId, instruction, cfg, signal, cueId, contextControls);
  } catch (err) {
    const message = signal.aborted ? "Task cancelled." : String(err.message || err);
    send(tabId, { cmd: signal.aborted ? "done" : "error", cueId, summary: message, text: message });
    await saveTaskState(cueId, { status: signal.aborted ? "cancelled" : "error", instruction, lastResult: message, tabId });
  } finally {
    if (tasks.get(cueId)?.controller === controller) tasks.delete(cueId);
  }
}

async function maybeRequestAndroidSpeak(tabId, instruction, cfg, signal, cueId) {
  const text = parseAndroidSpeakIntent(instruction);
  if (!text) return false;
  await saveTaskState(cueId, { status: "running", instruction, step: 0, lastResult: "queueing Android speech request", tabId });
  send(tabId, { cmd: "progress", cueId, text: "sending to phone…" });
  throwIfAborted(signal);

  const sessionId = await getStableSessionId();
  const deviceId = await getStableDeviceId();
  const data = await callGateway(cfg, "/v1/tool/requests", {
    signal,
    body: {
      source: "agee-extension",
      source_device_id: deviceId,
      source_surface_type: "browser_extension",
      target_surface_type: "android",
      tool: "audio.speak",
      input: { text },
      session_id: sessionId,
      branch_id: cueId || "browser",
      instruction,
    },
  });
  const request = data?.request || {};
  const target = request.target_device_id
    ? `for ${request.target_device_id}`
    : "for the next Android client heartbeat";
  const summary = `Queued Android speech request ${request.id || ""} ${target}.`;
  send(tabId, { cmd: "done", cueId, summary });
  await saveTaskState(cueId, {
    status: "done",
    instruction,
    step: 1,
    tabId,
    lastResult: summary,
    toolRequestId: request.id || "",
  });
  return true;
}

function parseAndroidSpeakIntent(instruction) {
  const value = String(instruction || "").trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  if (!/\b(?:android|phone|mobile)\b/.test(lower)) return "";
  if (!/\b(?:say|speak|read|announce)\b/.test(lower)) return "";

  const quoted = value.match(/["“”']([^"“”']{1,500})["“”']/);
  if (quoted?.[1]) return quoted[1].trim();

  const patterns = [
    /\b(?:android|phone|mobile)\b.*?\b(?:say|speak|read|announce)\b\s*:?\s*(.+)$/i,
    /\b(?:say|speak|read|announce)\b\s+(.+?)\s+\b(?:on|from|through)\b\s+(?:the\s+)?(?:android|phone|mobile)\b/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const text = match?.[1]?.trim();
    if (text) return text.replace(/[.?!]\s*$/, "").slice(0, 500);
  }
  return "";
}

async function maybeOpenRequestedTab(tabId, instruction, signal, cueId) {
  const intent = parseOpenTabIntent(instruction);
  if (!intent) return false;
  throwIfAborted(signal);
  const url = new URL(intent.url);
  if (!ALLOWED_NAVIGATION_PROTOCOLS.has(url.protocol)) {
    send(tabId, { cmd: "error", cueId, text: `Blocked unsupported URL: ${intent.url}` });
    return true;
  }
  const opened = await chrome.tabs.create({ url: url.href, active: true });
  const summary = `Opened ${opened.url || url.href}.`;
  send(tabId, { cmd: "done", cueId, summary });
  await saveTaskState(cueId, {
    status: "done",
    instruction,
    step: 1,
    tabId,
    lastResult: summary,
    openedTabId: opened.id,
  });
  return true;
}

// ---- CDP task agent (router → disposable background-tab agent) -------------
// The product framing: a sterile router launches N disposable task agents, each
// driving its OWN background tab via chrome.debugger (Chrome DevTools Protocol).
// This is the minimal verifiable spike of ONE such agent: open a background tab
// (active:false, no focus steal), attach the debugger, navigate + screenshot +
// one input event + read a little page state over CDP, detach, dispose the tab,
// and ping the overlay "done" on the cue path the rest of the extension uses.
//
// Trust boundary: this drives a browser tab; it touches NO API keys and makes
// NO model calls. The instruction is a label for the disposable run, not an
// executable command.

const CDP_PROTOCOL_VERSION = "1.3";

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, CDP_PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve) => {
    try {
      chrome.debugger.detach(target, () => {
        void chrome.runtime.lastError; // tolerate already-detached / gone tab
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function debuggerSend(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`${method}: ${err.message}`));
      else resolve(result || {});
    });
  });
}

// Wait until the background tab reports a non-loading state, or time out. We
// avoid focusing the tab; we only poll its status via chrome.tabs.get.
async function waitForBackgroundTabLoad(tabId, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return;
    } catch {
      return; // tab gone
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Run one disposable task agent in its own background tab. `overlayTabId` is the
// user's foreground tab whose overlay shows the cue; `instruction`/`url` come
// from the {cmd:"branch"} intent. Never activates the background tab.
//
// `opts.parentRunId` (optional) threads fan-out lineage so concurrent workers in
// one BRANCH-TO-TWO trigger share a gateway parent. When a gateway is configured
// we ALSO register a router activation for this worker: the gateway launches its
// disposable agent run, tracks it, and emits a durable router_ping the overlay
// renders. The CDP browser work and the gateway activation run concurrently; the
// gateway's harness output is a proposal we summarize, never an executable
// command.
async function runBranchTaskAgent(overlayTabId, instruction, url, controller, cueId, opts = {}) {
  const signal = controller.signal;
  let bgTabId = null;
  let attached = false;
  const target = {};
  const navUrl = (() => {
    try {
      const u = new URL(url);
      return ALLOWED_NAVIGATION_PROTOCOLS.has(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  })();

  try {
    if (!navUrl) {
      send(overlayTabId, { cmd: "error", cueId, text: `branch: blocked or invalid url: ${url}` });
      await saveTaskState(cueId, { status: "error", instruction, lastResult: `invalid url ${url}`, tabId: overlayTabId });
      return;
    }

    await saveTaskState(cueId, { status: "running", instruction, step: 0, lastResult: "launching background task agent", tabId: overlayTabId });
    send(overlayTabId, { cmd: "progress", cueId, text: "launching background agent…" });
    throwIfAborted(signal);

    // Fuse the two PoCs: if a gateway is configured, register a router activation
    // for this worker. The gateway launches + tracks a disposable run and emits a
    // durable router_ping; we poll for it CONCURRENTLY with the CDP browser work
    // below so neither blocks the other. Best-effort: a gateway hiccup must not
    // sink the local browser task.
    const cfg = await getConfig();
    let routerPromise = null;
    let routerRunId = null;
    if (cfg.gatewayUrl) {
      routerPromise = (async () => {
        const { runId } = await routerActivate(cfg, {
          intent: instruction,
          parentRunId: opts.parentRunId,
          signal,
        });
        routerRunId = runId;
        await saveTaskState(cueId, { status: "running", instruction, routerRunId: runId, tabId: overlayTabId });
        return waitForRouterPing(cfg, runId, signal);
      })().catch((err) => ({ error: String(err?.message || err) }));
    }

    // Disposable background tab — the agent's own surface. active:false is the
    // whole contract: it must never steal the user's focus.
    const bgTab = await chrome.tabs.create({ url: "about:blank", active: false });
    bgTabId = bgTab.id;
    target.tabId = bgTabId;

    // One debugger client per tab: attach can fail (e.g. DevTools already
    // attached). Emit an error cue instead of throwing.
    try {
      await debuggerAttach(target);
      attached = true;
    } catch (err) {
      send(overlayTabId, { cmd: "error", cueId, text: `branch: could not attach debugger (${err.message})` });
      await saveTaskState(cueId, { status: "error", instruction, lastResult: `attach failed: ${err.message}`, tabId: overlayTabId });
      return;
    }

    throwIfAborted(signal);
    await debuggerSend(target, "Page.enable");
    await debuggerSend(target, "Runtime.enable");

    send(overlayTabId, { cmd: "progress", cueId, text: "navigating background tab…" });
    await debuggerSend(target, "Page.navigate", { url: navUrl });
    await waitForBackgroundTabLoad(bgTabId);
    throwIfAborted(signal);

    // Capture a screenshot of the BACKGROUND tab over CDP (no foreground capture,
    // so the user's visible tab is untouched).
    send(overlayTabId, { cmd: "progress", cueId, text: "capturing background screenshot…" });
    const shot = await debuggerSend(target, "Page.captureScreenshot", { format: "jpeg", quality: 40 });
    const screenshotBytes = shot?.data ? shot.data.length : 0;
    if (!screenshotBytes) throw new Error("background screenshot capture returned no data");

    // Dispatch exactly ONE input event into the background tab. A keyboard event
    // is enough to prove we can drive input over CDP without focusing the tab.
    throwIfAborted(signal);
    await debuggerSend(target, "Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await debuggerSend(target, "Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });

    // Read a little page state back over CDP.
    const evalRes = await debuggerSend(target, "Runtime.evaluate", {
      expression: "JSON.stringify({ title: document.title, url: location.href, ready: document.readyState })",
      returnByValue: true,
    });
    let pageState = {};
    try {
      pageState = JSON.parse(evalRes?.result?.value || "{}");
    } catch {
      pageState = {};
    }

    // Confirm the background tab never became active (focus contract).
    let stayedBackground = true;
    try {
      const finalTab = await chrome.tabs.get(bgTabId);
      stayedBackground = finalTab.active === false;
    } catch {
      // tab already gone — treat as background (it was never surfaced)
    }

    // Await the gateway router_ping (if we started one) so the overlay reflects
    // both sides of the fused loop: the CDP browser work AND the durable router
    // ping. The ping summary is a proposal we render, never executed.
    let routerPing = null;
    if (routerPromise) {
      send(overlayTabId, { cmd: "progress", cueId, text: "awaiting router ping…" });
      routerPing = await routerPromise;
    }

    const title = pageState.title || "(untitled)";
    let summary =
      `Background task agent done — opened "${title}", captured ${Math.round(screenshotBytes / 1024)}KB screenshot, ` +
      `dispatched 1 input event${stayedBackground ? ", tab stayed in background." : " (warning: tab became active)."}`;
    if (routerPing && !routerPing.error && routerPing.summary) {
      summary += ` Router ping: ${truncate(String(routerPing.summary), 160)}`;
    } else if (routerPing && routerPing.error) {
      summary += ` (router ping unavailable: ${truncate(routerPing.error, 120)})`;
    }
    send(overlayTabId, { cmd: "done", cueId, summary });
    await saveTaskState(cueId, {
      status: "done",
      instruction,
      step: 1,
      tabId: overlayTabId,
      routerRunId,
      routerPingOk: Boolean(routerPing && !routerPing.error && routerPing.ok),
      lastResult: summary.slice(0, 400),
    });
  } catch (err) {
    const message = signal.aborted ? "Task cancelled." : `branch failed: ${String(err.message || err)}`;
    send(overlayTabId, { cmd: signal.aborted ? "done" : "error", cueId, summary: message, text: message });
    await saveTaskState(cueId, { status: signal.aborted ? "cancelled" : "error", instruction, lastResult: message, tabId: overlayTabId });
  } finally {
    if (attached) await debuggerDetach(target);
    // Dispose the throwaway tab — task agents are disposable by design.
    if (bgTabId != null) {
      try {
        await chrome.tabs.remove(bgTabId);
      } catch {
        // tab already closed
      }
    }
    if (tasks.get(cueId)?.controller === controller) tasks.delete(cueId);
  }
}

// BRANCH-TO-TWO (the headline): one trigger fans out to N disposable task
// agents that run CONCURRENTLY, each in its OWN background tab with its OWN cue.
// Neither steals focus; each pings independently on completion; each registers
// its own gateway router activation under a shared parent run, so the gateway
// records one router_ping per worker.
//
// `branches` is an array of { instruction, url, cueId }. We start every worker
// in the same tick (no awaiting between launches) so they are genuinely
// in-flight together, then let each finish on its own lane.
async function runBranchFanout(overlayTabId, branches, controllersByCue) {
  // A shared parent gateway run ties the fan-out together as lineage. Best-effort:
  // if the gateway is down or unset, the workers still run locally.
  let parentRunId = null;
  try {
    const cfg = await getConfig();
    if (cfg.gatewayUrl) {
      const parent = await routerActivate(cfg, {
        intent: `fan-out: ${branches.length} concurrent task agents`,
        signal: undefined,
      });
      parentRunId = parent.runId;
    }
  } catch {
    parentRunId = null; // lineage is a nicety, not a requirement
  }

  // Launch every worker without awaiting between them: they share this tick and
  // are therefore concurrently in flight.
  for (const branch of branches) {
    const controller = controllersByCue.get(branch.cueId);
    if (!controller) continue;
    runBranchTaskAgent(overlayTabId, branch.instruction, branch.url, controller, branch.cueId, {
      parentRunId,
    });
  }
}

// Generate a cueId server-side if the content script didn't supply one, so old
// callers still work. Each cue is independent — we never reject a new one.
function nextCueId(provided) {
  if (typeof provided === "string" && provided) return provided;
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Cancel every running cue on a tab (Stop button with no specific cue).
function cancelTabCues(tabId) {
  for (const [cueId, task] of tasks) {
    if (task.tabId === tabId) {
      task.controller.abort();
      tasks.delete(cueId);
    }
  }
}

// ---- Ambient capture loop (continuous / rung-3 interaction mode) ----------
// While active, sample the screen on a fixed interval (~200ms target) and POST
// each frame to the gateway's /v1/voice/frames intake. Self-throttling: it
// never overlaps a post, so a slow capture lowers the effective rate instead of
// piling requests up. One ambient run at a time (one person, one screen).
const AMBIENT_MIN_INTERVAL_MS = 100;
const AMBIENT_DEFAULT_INTERVAL_MS = 200;
let ambient = null; // { tabId, timer, seq, inFlight, sessionId }

async function startAmbientCapture(tabId, intervalMs) {
  if (ambient) stopAmbientCapture();
  const interval = Math.max(AMBIENT_MIN_INTERVAL_MS, Number(intervalMs) || AMBIENT_DEFAULT_INTERVAL_MS);
  const sessionId = await getStableSessionId();
  ambient = { tabId, timer: null, seq: 0, inFlight: false, intervalMs: interval, sessionId };
  send(tabId, { cmd: "ambient", state: "on" });
  ambient.timer = setInterval(() => captureAmbientFrame().catch(() => {}), interval);
  captureAmbientFrame().catch(() => {});
  return { ok: true, intervalMs: interval, sessionId };
}

function stopAmbientCapture() {
  if (!ambient) return;
  clearInterval(ambient.timer);
  const tabId = ambient.tabId;
  ambient = null;
  try { send(tabId, { cmd: "ambient", state: "off" }); } catch {}
}

async function captureAmbientFrame() {
  if (!ambient || ambient.inFlight) return; // self-throttle: skip while a post is pending
  ambient.inFlight = true;
  const tabId = ambient.tabId;
  try {
    const cfg = await getConfig();
    if (!cfg.gatewayUrl) { stopAmbientCapture(); return; }
    let screen;
    try {
      const snap = await ask(tabId, { cmd: "snapshot" });
      screen = snapToScreen(snap);
    } catch {
      screen = undefined; // restricted page; still send a frame so cadence holds
    }
    await callGateway(cfg, "/v1/voice/frames", {
      body: { source: "agee-extension", session_id: ambient.sessionId, seq: ambient.seq++, screen },
    });
  } finally {
    if (ambient) ambient.inFlight = false;
  }
}

// ---- Local, tab-scoped proactive suggestions -----------------------------
// Grants and structural signals are memory-only. Nothing in this section
// writes page-derived state to chrome.storage or contacts a gateway until the
// user accepts the fully disclosed text-only turn.
function proactiveDocumentId(sender) {
  return typeof sender?.documentId === "string" ? sender.documentId : "";
}

function proactiveFrameId(sender) {
  return Number.isInteger(sender?.frameId) ? sender.frameId : -1;
}

function proactiveSendOptions(grant) {
  return { documentId: grant.document_id, frameId: grant.frame_id };
}

function proactiveGrantForSender(sender, grantId) {
  const tabId = sender?.tab?.id;
  if (tabId == null) return { error: "missing_tab" };
  const grant = proactiveGrants.get(tabId);
  if (!grant || grant.grant_id !== String(grantId || "")) return { error: "grant_missing" };
  if (
    !grant.document_id
    || grant.document_id !== proactiveDocumentId(sender)
    || grant.frame_id !== proactiveFrameId(sender)
  ) {
    revokeProactiveGrant(tabId, "document_mismatch");
    return { error: "document_mismatch" };
  }
  if (Date.now() >= grant.expires_at) {
    revokeProactiveGrant(tabId, "expired");
    return { error: "expired" };
  }
  return { tabId, grant };
}

function sanitizeProactiveSignals(input) {
  const source = input && typeof input === "object" ? input : {};
  const output = { schema_version: 1 };
  for (const key of PROACTIVE_SIGNAL_KEYS) {
    const value = Number(source[key]);
    output[key] = Number.isFinite(value) && value > 0 ? Math.min(100, Math.floor(value)) : 0;
  }
  return output;
}

async function proactiveDestination() {
  const cfg = await getConfig();
  const gatewayUrl = String(cfg.gatewayUrl || "").replace(/\/+$/, "");
  if (!gatewayUrl) throw new Error("missing_destination");
  const parsed = new URL(gatewayUrl);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || (parsed.pathname && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash
  ) throw new Error("invalid_destination");
  const origin = parsed.origin;
  return {
    cfg: { ...cfg, gatewayUrl: origin },
    origin,
    requestUrl: `${origin}/v1/proactive/turns`,
  };
}

async function digestProactiveValue(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function proactiveRequestBody(kind) {
  const transcript = PROACTIVE_PROMPTS[String(kind || "")];
  if (!transcript) return null;
  return {
    source: "proactive_accept_v1",
    transcript,
    modality: "text",
    client: {
      platform: "browser",
      source: "agee-extension",
      input: "text",
    },
  };
}

async function proactiveBackgroundConnectivity() {
  await initializePrivacyState();
  if (!chrome?.storage?.local) return "disabled";
  const stored = await chrome.storage.local.get({
    [BACKGROUND_AUTOMATION_KEY]: false,
    [BACKGROUND_AUTOMATION_CONSENT_KEY]: 0,
  });
  return stored[BACKGROUND_AUTOMATION_KEY] === true
    && Number(stored[BACKGROUND_AUTOMATION_CONSENT_KEY]) === BACKGROUND_AUTOMATION_CONSENT_VERSION
    ? "enabled"
    : "disabled";
}

function proactiveConfirmationForGrant(grant) {
  for (const confirmation of proactiveConfirmations.values()) {
    if (confirmation.grant === grant) return confirmation;
  }
  return null;
}

function scheduleProactiveConfirmationAlarm() {
  if (!chrome?.alarms) return;
  const expiries = [...proactiveConfirmations.values()]
    .filter((confirmation) => confirmation.state === "pending")
    .map((confirmation) => confirmation.expires_at);
  if (expiries.length === 0) {
    chrome.alarms.clear(PROACTIVE_CONFIRMATION_ALARM).catch(() => {});
    return;
  }
  try {
    chrome.alarms.create(PROACTIVE_CONFIRMATION_ALARM, { when: Math.min(...expiries) });
  } catch {}
}

function expireProactiveConfirmations() {
  const now = Date.now();
  for (const confirmation of [...proactiveConfirmations.values()]) {
    if (confirmation.state !== "pending" || now < confirmation.expires_at) continue;
    if (proactiveGrants.get(confirmation.tab_id) === confirmation.grant) {
      revokeProactiveGrant(confirmation.tab_id, "confirmation_expired");
    } else {
      removeProactiveConfirmation(confirmation, "confirmation_expired", { closeWindow: true, notify: true });
    }
  }
  scheduleProactiveConfirmationAlarm();
}

function removeProactiveConfirmation(confirmation, reason, { closeWindow = false, notify = false } = {}) {
  if (!confirmation) return;
  if (proactiveConfirmations.get(confirmation.token) === confirmation) {
    proactiveConfirmations.delete(confirmation.token);
  }
  if (confirmation.expiry_timer) clearTimeout(confirmation.expiry_timer);
  confirmation.expiry_timer = null;
  confirmation.state = reason || "closed";
  if (closeWindow && Number.isInteger(confirmation.window_id)) {
    chrome.windows.remove(confirmation.window_id).catch(() => {});
  }
  if (notify) {
    send(confirmation.tab_id, {
      cmd: "proactiveConfirmationResult",
      cueId: confirmation.cue_id,
      grantId: confirmation.grant.grant_id,
      ok: false,
      reason: reason || "confirmation_closed",
    });
  }
  scheduleProactiveConfirmationAlarm();
}

function revokeProactiveGrant(tabId, reason = "revoked", notify = true) {
  const grant = proactiveGrants.get(tabId);
  if (!grant) return false;
  proactiveGrants.delete(tabId);
  const confirmation = proactiveConfirmationForGrant(grant);
  if (confirmation) {
    removeProactiveConfirmation(confirmation, reason, {
      closeWindow: reason !== "confirmation_window_closed",
      notify: true,
    });
  }
  if (notify) send(tabId, { cmd: "proactiveGrantRevoked", grantId: grant.grant_id, reason });
  return true;
}

function revokeAllProactiveGrants(reason = "revoked") {
  for (const tabId of [...proactiveGrants.keys()]) revokeProactiveGrant(tabId, reason);
}

// Narrow, count-only runtime QA hook. It cannot reveal grant ids, documents,
// destinations, or page-derived data.
globalThis.AgeeProactivePrivacy = Object.freeze({
  activeGrantCount: () => proactiveGrants.size,
  pendingConfirmationCount: () => proactiveConfirmations.size,
});

async function startProactiveGrant(sender) {
  const tabId = sender?.tab?.id;
  const documentId = proactiveDocumentId(sender);
  const frameId = proactiveFrameId(sender);
  if (tabId == null || !documentId || frameId !== 0) return { ok: false, reason: "document_id_unavailable" };
  if (sender.tab?.incognito) return { ok: false, suppressed: true, reason: "incognito" };
  let protocol = "";
  try { protocol = new URL(String(sender.tab?.url || "")).protocol; } catch {}
  if (protocol !== "http:" && protocol !== "https:") {
    return { ok: false, suppressed: true, reason: "unsupported_protocol" };
  }
  revokeProactiveGrant(tabId, "replaced", false);
  const now = Date.now();
  const grant = {
    schema_version: 1,
    tab_id: tabId,
    document_id: documentId,
    frame_id: frameId,
    grant_id: `pg_${crypto.randomUUID()}`,
    issued_at: now,
    expires_at: now + PROACTIVE_GRANT_TTL_MS,
    state: "initializing",
    destination_digest: "",
    background_connectivity: "disabled",
  };
  proactiveGrants.set(tabId, grant);
  let destination;
  try {
    destination = await proactiveDestination();
    const [destinationDigest, backgroundConnectivity, sensitivity] = await Promise.all([
      digestProactiveValue(destination.requestUrl),
      proactiveBackgroundConnectivity(),
      ask(
        tabId,
        { cmd: "proactiveSensitivityCheck" },
        proactiveSendOptions(grant),
      ).catch(() => ({ suppressed: true, reason: "document_unavailable" })),
    ]);
    if (proactiveGrants.get(tabId) !== grant || grant.state !== "initializing") {
      return { ok: false, reason: "revoked" };
    }
    if (sensitivity?.suppressed !== false) {
      proactiveGrants.delete(tabId);
      return {
        ok: false,
        suppressed: true,
        reason: String(sensitivity?.reason || "sensitive_page"),
      };
    }
    grant.destination_digest = destinationDigest;
    grant.background_connectivity = backgroundConnectivity;
    grant.state = "granted";
  } catch (error) {
    if (proactiveGrants.get(tabId) === grant) proactiveGrants.delete(tabId);
    throw error;
  }
  return {
    ok: true,
    grantId: grant.grant_id,
    state: grant.state,
    expiresAt: grant.expires_at,
    destinationOrigin: destination.origin,
    backgroundConnectivity: grant.background_connectivity,
  };
}

async function noteProactiveSignal(sender, msg) {
  const result = proactiveGrantForSender(sender, msg.grantId);
  if (result.error) return { ok: false, reason: result.error };
  if (result.grant.state !== "granted" && result.grant.state !== "card_visible") {
    return { ok: false, reason: "invalid_state" };
  }
  // Validate and discard. Content owns the one local classification/card;
  // background retains no page-derived signal or suggestion.
  sanitizeProactiveSignals(msg.signals);
  result.grant.state = "card_visible";
  const destination = await proactiveDestination();
  const destinationDigest = await digestProactiveValue(destination.requestUrl);
  if (proactiveGrants.get(result.tabId) !== result.grant || result.grant.state !== "card_visible") {
    return { ok: false, reason: "revoked" };
  }
  if (destinationDigest !== result.grant.destination_digest) {
    revokeProactiveGrant(result.tabId, "destination_changed");
    return { ok: false, reason: "destination_changed" };
  }
  return {
    ok: true,
    state: result.grant.state,
    expiresAt: result.grant.expires_at,
    destinationOrigin: destination.origin,
    backgroundConnectivity: result.grant.background_connectivity,
  };
}

async function proactiveGrantStatus(sender, msg) {
  const result = proactiveGrantForSender(sender, msg.grantId);
  if (result.error) return { ok: false, state: "off", reason: result.error };
  return { ok: true, state: result.grant.state, expiresAt: result.grant.expires_at };
}

function proactiveConfirmationClientStatus(sender, msg) {
  const tabId = sender?.tab?.id;
  const documentId = proactiveDocumentId(sender);
  const frameId = proactiveFrameId(sender);
  const cueId = String(msg.cueId || "");
  if (tabId == null || !documentId || frameId !== 0 || !cueId) {
    return { ok: false, state: "off", reason: "confirmation_missing" };
  }
  let confirmation = null;
  for (const candidate of proactiveConfirmations.values()) {
    if (
      candidate.tab_id === tabId
      && candidate.document_id === documentId
      && candidate.frame_id === frameId
      && candidate.cue_id === cueId
      && (candidate.state === "pending" || candidate.state === "consuming")
    ) {
      confirmation = candidate;
      break;
    }
  }
  if (!confirmation) return { ok: false, state: "off", reason: "confirmation_missing" };
  if (confirmation.state === "pending" && Date.now() >= confirmation.expires_at) {
    revokeProactiveGrant(tabId, "confirmation_expired");
    return { ok: false, state: "off", reason: "confirmation_expired" };
  }
  return { ok: true, state: confirmation.state, expiresAt: confirmation.expires_at };
}

async function openProactiveConfirmation(sender, msg) {
  const result = proactiveGrantForSender(sender, msg.grantId);
  if (result.error) return { ok: false, reason: result.error };
  const kind = String(msg.kind || "");
  const body = proactiveRequestBody(kind);
  if (!body || result.grant.state !== "card_visible") return { ok: false, reason: "invalid_card" };

  // Bind the re-check to the exact top-frame document that received the grant.
  const sensitivity = await ask(
    result.tabId,
    { cmd: "proactiveSensitivityCheck" },
    proactiveSendOptions(result.grant),
  ).catch(() => ({ suppressed: true }));
  if (sensitivity?.suppressed !== false) {
    revokeProactiveGrant(result.tabId, "sensitive_before_accept");
    return { ok: false, suppressed: true, reason: String(sensitivity?.reason || "sensitive_before_accept") };
  }

  const destination = await proactiveDestination();
  const [destinationDigest, bodyDigest, authorizationDigest, backgroundConnectivity] = await Promise.all([
    digestProactiveValue(destination.requestUrl),
    digestProactiveValue(JSON.stringify(body)),
    digestProactiveValue(destination.cfg.gatewayToken ? `Bearer ${destination.cfg.gatewayToken}` : ""),
    proactiveBackgroundConnectivity(),
  ]);
  const current = proactiveGrants.get(result.tabId);
  if (current !== result.grant || result.grant.state !== "card_visible") {
    return { ok: false, reason: "revoked" };
  }
  if (destinationDigest !== result.grant.destination_digest) {
    revokeProactiveGrant(result.tabId, "destination_changed");
    return { ok: false, reason: "destination_changed" };
  }

  // This is the only state transition initiated from the page. It opens an
  // extension-owned boundary; it does not authorize or send the request.
  const token = `pc_${crypto.randomUUID()}`;
  const confirmation = {
    token,
    state: "pending",
    grant: result.grant,
    tab_id: result.tabId,
    document_id: result.grant.document_id,
    frame_id: result.grant.frame_id,
    kind,
    cue_id: String(msg.cueId || ""),
    body,
    body_digest: bodyDigest,
    destination_digest: destinationDigest,
    destination_origin: destination.origin,
    request_url: destination.requestUrl,
    authorization_present: Boolean(destination.cfg.gatewayToken),
    authorization_digest: authorizationDigest,
    background_connectivity: backgroundConnectivity,
    connectivity_observed_at: new Date().toISOString(),
    expires_at: Math.min(result.grant.expires_at, Date.now() + PROACTIVE_CONFIRMATION_TTL_MS),
    window_id: null,
    expiry_timer: null,
  };
  result.grant.state = "confirmation_pending";
  proactiveConfirmations.set(token, confirmation);
  confirmation.expiry_timer = setTimeout(() => {
    if (proactiveConfirmations.get(token) === confirmation && confirmation.state === "pending") {
      revokeProactiveGrant(result.tabId, "confirmation_expired");
    }
  }, Math.max(0, confirmation.expires_at - Date.now()));
  scheduleProactiveConfirmationAlarm();

  let popup;
  try {
    popup = await chrome.windows.create({
      url: chrome.runtime.getURL(`proactive-confirm.html#${token}`),
      type: "popup",
      focused: true,
      width: 560,
      height: 720,
    });
  } catch (error) {
    if (proactiveConfirmations.get(token) === confirmation) {
      removeProactiveConfirmation(confirmation, "confirmation_window_failed");
      result.grant.state = "card_visible";
    }
    return { ok: false, reason: `confirmation_window_failed:${String(error?.message || error)}` };
  }
  if (!Number.isInteger(popup?.id)) {
    if (proactiveConfirmations.get(token) === confirmation) {
      removeProactiveConfirmation(confirmation, "confirmation_window_identity_unavailable");
      result.grant.state = "card_visible";
    }
    return { ok: false, reason: "confirmation_window_identity_unavailable" };
  }
  confirmation.window_id = popup.id;
  if (
    proactiveConfirmations.get(token) !== confirmation
    || proactiveGrants.get(result.tabId) !== result.grant
  ) {
    chrome.windows.remove(popup.id).catch(() => {});
    return { ok: false, reason: "revoked" };
  }
  try {
    await chrome.windows.get(popup.id);
  } catch {
    if (proactiveConfirmations.get(token) === confirmation) {
      revokeProactiveGrant(result.tabId, "confirmation_window_closed");
    }
    return { ok: false, reason: "confirmation_window_closed" };
  }
  if (
    proactiveConfirmations.get(token) !== confirmation
    || proactiveGrants.get(result.tabId) !== result.grant
  ) return { ok: false, reason: "revoked" };
  return {
    ok: true,
    state: "confirmation_pending",
  };
}

function proactiveConfirmationSender(sender, token) {
  if (sender?.id !== chrome.runtime.id || typeof sender?.url !== "string") return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "chrome-extension:"
      && url.hostname === chrome.runtime.id
      && url.pathname === "/proactive-confirm.html"
      && url.hash === `#${String(token || "")}`;
  } catch {
    return false;
  }
}

function proactiveConfirmationDetails(sender, msg) {
  const token = String(msg.token || "");
  if (!proactiveConfirmationSender(sender, token)) return { ok: false, reason: "untrusted_confirmation_surface" };
  const confirmation = proactiveConfirmations.get(token);
  if (!confirmation || confirmation.state !== "pending") return { ok: false, reason: "confirmation_missing" };
  if (Date.now() >= confirmation.expires_at) {
    revokeProactiveGrant(confirmation.tab_id, "confirmation_expired");
    return { ok: false, reason: "confirmation_expired" };
  }
  return {
    ok: true,
    expiresAt: confirmation.expires_at,
    request: {
      url: confirmation.request_url,
      method: "POST",
      redirect: "error",
      headers: {
        content_type: "application/json",
        authorization: confirmation.authorization_present ? "configured bearer token (value hidden)" : "none",
      },
      body: confirmation.body,
      bodyDigest: confirmation.body_digest,
    },
    backgroundConnectivity: confirmation.background_connectivity,
    connectivityObservedAt: confirmation.connectivity_observed_at,
    persistence: "Chief Moa does not add this proactive request or response to conversation, task, workflow, broker, or agent-run storage. The configured model provider still processes the packaged prompt under its own data policy.",
    exclusions: "No screenshot, page body, URL, title, form value, cookie, history, selection, element, structural count, action, task, workflow, agent-run instruction, broker event, context pack, evidence, session id, or conversation id is included.",
  };
}

async function decideProactiveConfirmation(sender, msg) {
  const token = String(msg.token || "");
  if (!proactiveConfirmationSender(sender, token)) return { ok: false, reason: "untrusted_confirmation_surface" };
  const confirmation = proactiveConfirmations.get(token);
  if (!confirmation || confirmation.state !== "pending") return { ok: false, reason: "confirmation_missing" };
  if (msg.decision !== "allow") {
    removeProactiveConfirmation(confirmation, "cancelled", { notify: true });
    if (proactiveGrants.get(confirmation.tab_id) === confirmation.grant) {
      proactiveGrants.delete(confirmation.tab_id);
    }
    return { ok: true, state: "cancelled" };
  }
  if (Date.now() >= confirmation.expires_at) {
    revokeProactiveGrant(confirmation.tab_id, "confirmation_expired");
    return { ok: false, reason: "confirmation_expired" };
  }

  const sensitivity = await ask(
    confirmation.tab_id,
    { cmd: "proactiveSensitivityCheck" },
    { documentId: confirmation.document_id, frameId: confirmation.frame_id },
  ).catch(() => ({ suppressed: true }));
  if (sensitivity?.suppressed !== false) {
    revokeProactiveGrant(confirmation.tab_id, "sensitive_before_accept");
    return { ok: false, reason: String(sensitivity?.reason || "sensitive_before_accept") };
  }

  const destination = await proactiveDestination();
  const [destinationDigest, bodyDigest, authorizationDigest] = await Promise.all([
    digestProactiveValue(destination.requestUrl),
    digestProactiveValue(JSON.stringify(confirmation.body)),
    digestProactiveValue(destination.cfg.gatewayToken ? `Bearer ${destination.cfg.gatewayToken}` : ""),
  ]);
  const currentGrant = proactiveGrants.get(confirmation.tab_id);
  const currentConfirmation = proactiveConfirmations.get(token);
  if (
    currentGrant !== confirmation.grant
    || currentConfirmation !== confirmation
    || confirmation.state !== "pending"
    || confirmation.grant.state !== "confirmation_pending"
  ) return { ok: false, reason: "revoked" };
  if (
    destinationDigest !== confirmation.destination_digest
    || bodyDigest !== confirmation.body_digest
    || authorizationDigest !== confirmation.authorization_digest
    || destination.requestUrl !== confirmation.request_url
  ) {
    revokeProactiveGrant(confirmation.tab_id, "disclosure_changed");
    return { ok: false, reason: "disclosure_changed" };
  }

  // No await occurs between this final identity/state check and consumption.
  // Concurrent decisions therefore cannot issue a second request.
  confirmation.state = "consuming";
  confirmation.grant.state = "consuming";
  if (confirmation.expiry_timer) clearTimeout(confirmation.expiry_timer);
  confirmation.expiry_timer = null;
  scheduleProactiveConfirmationAlarm();
  proactiveGrants.delete(confirmation.tab_id);

  let data;
  const requestController = new AbortController();
  const requestTimeout = setTimeout(() => requestController.abort("proactive_request_timeout"), PROACTIVE_REQUEST_TIMEOUT_MS);
  try {
    data = await callGateway(destination.cfg, "/v1/proactive/turns", {
      redirect: "error",
      body: confirmation.body,
      signal: requestController.signal,
      maxResponseBytes: PROACTIVE_RESPONSE_MAX_BYTES,
    });
  } catch (error) {
    const reason = String(error?.message || error);
    removeProactiveConfirmation(confirmation, "request_failed");
    send(confirmation.tab_id, {
      cmd: "proactiveConfirmationResult",
      cueId: confirmation.cue_id,
      grantId: confirmation.grant.grant_id,
      ok: false,
      reason,
    });
    return { ok: false, reason };
  } finally {
    clearTimeout(requestTimeout);
  }

  const responseViolation = proactiveResponseViolation(data);
  let refusalReceipt;
  try {
    refusalReceipt = await recordProactiveRefusalReceipt(data, responseViolation);
  } catch (error) {
    const reason = `The gateway response violated the proactive text-only protocol, and its local refusal receipt could not be stored: ${String(error?.message || error)}`;
    removeProactiveConfirmation(confirmation, "protocol_receipt_failed");
    send(confirmation.tab_id, {
      cmd: "proactiveConfirmationResult",
      cueId: confirmation.cue_id,
      grantId: confirmation.grant.grant_id,
      ok: false,
      reason,
    });
    return { ok: false, reason };
  }
  if (refusalReceipt) {
    const reason = "The gateway returned prohibited action/proposal data. It was ignored and recorded as a local protocol violation.";
    removeProactiveConfirmation(confirmation, "protocol_violation");
    send(confirmation.tab_id, {
      cmd: "proactiveConfirmationResult",
      cueId: confirmation.cue_id,
      grantId: confirmation.grant.grant_id,
      ok: false,
      reason,
    });
    return { ok: false, reason, refusalReceipt };
  }
  const summary = String(data?.display || data?.text || data?.speak || "Done.").trim().slice(0, 4000);
  removeProactiveConfirmation(confirmation, "completed");
  send(confirmation.tab_id, {
    cmd: "proactiveConfirmationResult",
    cueId: confirmation.cue_id,
    grantId: confirmation.grant.grant_id,
    ok: true,
    summary,
  });
  return { ok: true, state: "sent", summary };
}

function proactiveProposalScan(data) {
  const actionKeys = new Set(["action", "actions", "proposal", "proposals"]);
  const seen = new Set();
  let count = 0;
  let visitedObjects = 0;
  let inspectedProperties = 0;
  let truncated = false;
  const scan = (value, depth = 0) => {
    if (value == null || typeof value !== "object" || count >= 20) return;
    if (depth > 6 || visitedObjects >= 200) {
      truncated = true;
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    visitedObjects += 1;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      inspectedProperties += 1;
      if (inspectedProperties > 200) {
        truncated = true;
        return;
      }
      const child = value[key];
      if (actionKeys.has(String(key).toLowerCase())) {
        count += Array.isArray(child) ? Math.min(20 - count, child.length) : 1;
        if (count >= 20) return;
        continue;
      }
      scan(child, depth + 1);
      if (count >= 20) return;
    }
  };
  scan(data);
  return { count: Math.min(20, count), truncated };
}

function proactiveResponseViolation(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "invalid_response_shape";
  const expectedKeys = new Set(["actions", "classification", "display", "persisted", "source", "text"]);
  let keyCount = 0;
  for (const key in data) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    keyCount += 1;
    if (!expectedKeys.has(key) || keyCount > expectedKeys.size) return "invalid_response_shape";
  }
  if (keyCount !== expectedKeys.size) return "invalid_response_shape";
  if (
    data.source !== "proactive_accept_v1"
    || data.classification !== "proactive_text_only"
    || data.persisted !== false
    || !Array.isArray(data.actions)
    || data.actions.length !== 0
    || typeof data.display !== "string"
    || typeof data.text !== "string"
    || !data.text.trim()
    || data.display !== data.text
    || data.text.length > 4000
  ) return "invalid_response_contract";
  return "";
}

async function recordProactiveRefusalReceipt(data, forcedReason = "") {
  const scan = proactiveProposalScan(data);
  const reason = scan.count || scan.truncated
    ? "proactive_text_only_action_protocol_violation"
    : String(forcedReason || "");
  if (!reason) return null;
  if (!chrome?.storage?.local) throw new Error("local_receipt_storage_unavailable");
  const write = proactiveReceiptWrite.then(async () => {
    const stored = await chrome.storage.local.get({ [PROACTIVE_REFUSAL_RECEIPTS_KEY]: [] });
    const existing = Array.isArray(stored[PROACTIVE_REFUSAL_RECEIPTS_KEY])
      ? stored[PROACTIVE_REFUSAL_RECEIPTS_KEY]
      : [];
    const receipt = {
      schema_version: 1,
      receipt_id: `prr_${crypto.randomUUID()}`,
      source: "proactive_accept_v1",
      reason,
      proposal_count: scan.count,
      scan_truncated: scan.truncated,
      created_at: new Date().toISOString(),
    };
    await chrome.storage.local.set({
      [PROACTIVE_REFUSAL_RECEIPTS_KEY]: [...existing.slice(-(PROACTIVE_REFUSAL_RECEIPT_LIMIT - 1)), receipt],
    });
    return receipt;
  });
  proactiveReceiptWrite = write.catch(() => {});
  return write;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === "proactiveConfirmationDetails") {
    sendResponse(proactiveConfirmationDetails(sender, msg));
    return false;
  }
  if (msg.cmd === "proactiveConfirmationDecision") {
    decideProactiveConfirmation(sender, msg)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "proactiveGrantStart" && sender.tab) {
    startProactiveGrant(sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "proactiveGrantStop" && sender.tab) {
    const result = proactiveGrantForSender(sender, msg.grantId);
    if (!result.error) revokeProactiveGrant(result.tabId, String(msg.reason || "manual_stop"), false);
    sendResponse({ ok: !result.error, state: "off", reason: result.error || String(msg.reason || "manual_stop") });
    return true;
  }
  if (msg.cmd === "proactiveGrantStatus" && sender.tab) {
    proactiveGrantStatus(sender, msg).then(sendResponse).catch(() => sendResponse({ ok: false, state: "off" }));
    return true;
  }
  if (msg.cmd === "proactiveConfirmationStatus" && sender.tab) {
    sendResponse(proactiveConfirmationClientStatus(sender, msg));
    return false;
  }
  if (msg.cmd === "proactiveSignal" && sender.tab) {
    noteProactiveSignal(sender, msg).then(sendResponse).catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "proactiveConfirmationOpen" && sender.tab) {
    openProactiveConfirmation(sender, msg)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "offscreenVoiceAudio") {
    // Record-scoped capture ids buffer locally for /v1/audio-notes; everything
    // else is live voice audio for the gateway socket.
    if (isRecordSessionId(msg.voiceSessionId)) {
      sendResponse(appendRecordSessionAudio(msg.voiceSessionId, msg.audio));
      return true;
    }
    sendResponse(sendVoiceSessionAudio(msg.voiceSessionId, msg.audio));
    return true;
  }
  if (msg.cmd === "offscreenVoiceError") {
    if (isRecordSessionId(msg.voiceSessionId)) {
      discardRecordSession(msg.voiceSessionId, "microphone capture failed");
      sendResponse({ ok: true });
      return true;
    }
    handleOffscreenVoiceError(msg.voiceSessionId, msg.error);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.cmd === "recordSessionStart" && sender.tab) {
    revokeProactiveGrant(sender.tab.id, "another_workflow_started");
    startRecordSession(sender.tab.id)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "recordSessionStop") {
    stopRecordSession()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ stored: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "videoSessionStart" && sender.tab) {
    revokeProactiveGrant(sender.tab.id, "another_workflow_started");
    startVideoNoteSession(sender.tab.id)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "videoSessionStop") {
    stopVideoNoteSession(sender.tab?.id ?? null, msg.cueId || null)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ stored: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "offscreenVideoEnded") {
    // Chrome's "Stop sharing" bar (or the length cap) ended the capture. Tell
    // the owning tab so its overlay finishes the note like a stop press.
    const session = videoNoteSession;
    if (session && session.id === msg.videoSessionId && session.tabId != null) {
      send(session.tabId, { cmd: "videoNoteAutoStop" });
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.cmd === "voiceSessionStart" && sender.tab) {
    if (activeRecordSession()) {
      // The offscreen document has one capture slot; starting voice would
      // silently steal the microphone from the in-flight audio note.
      sendResponse({ ok: false, error: "An audio note recording is in progress. Stop recording before starting voice." });
      return true;
    }
    if (videoNoteSession) {
      sendResponse({ ok: false, error: "A video note recording is in progress. Stop recording before starting voice." });
      return true;
    }
    const tabId = sender.tab.id;
    revokeProactiveGrant(tabId, "another_workflow_started");
    claimActiveAgentTab(tabId, "another page voice session started", {
      cue_id: msg.cueId || null,
      status: "listening",
    });
    startVoiceSessionWithMode(tabId, {
      cueId: msg.cueId,
      turnId: msg.turnId,
      assistantOverlap: msg.assistantOverlap === true,
      capture: msg.capture === "extension-offscreen" ? "extension-offscreen" : "content-script",
      autoCommit: msg.autoCommit !== false,
      contextAction: msg.contextAction,
      threadLabel: msg.threadLabel,
    })
      .then((session) => {
        if (session?.voiceSessionId) {
          setActiveBrowserAgentOwner(tabId, "browser voice session started", {
            cue_id: msg.cueId || null,
            voice_session_id: session.voiceSessionId,
            status: "listening",
          }).catch(() => {});
        }
        sendResponse({ ok: true, ...session });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "voiceSessionAttach" && sender.tab) {
    sendResponse(attachVoiceSession(msg.voiceSessionId, sender.tab.id));
    return true;
  }
  if (msg.cmd === "voiceSessionAudio") {
    sendResponse(sendVoiceSessionAudio(msg.voiceSessionId, msg.audio));
    return true;
  }
  if (msg.cmd === "voiceSessionControl") {
    sendVoiceSessionControl(msg.voiceSessionId, msg.message)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "voiceSessionClose") {
    closeVoiceSession(msg.voiceSessionId, String(msg.reason || "closed"));
    sendResponse({ ok: true });
    return true;
  }
  if (msg.cmd === "devReloadExtension") {
    devReloadConfig()
      .then((cfg) => maybeReloadForDevVersion(msg.info || {}, {
        server: String(msg.server || cfg.server || DEV_RELOAD_DEFAULT_SERVER).replace(/\/+$/, ""),
        previousVersion: Number(msg.previousVersion || cfg.version || 0) || null,
        source: String(msg.source || "message"),
      }))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "history") {
    getConfig()
      .then((cfg) => loadHistory(cfg))
      .then((turns) => sendResponse({ ok: true, turns }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error), turns: [] }));
    return true;
  }
  if (msg.cmd === "voiceSessionTicket") {
    getConfig()
      .then((cfg) => createVoiceSessionTicket(cfg))
      .then((ticket) => sendResponse({ ok: true, ...ticket }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "voiceTurnFetch") {
    // The overlay asks for the gateway's stored copy of a voice turn to recover
    // the real assistant reply when a native-audio turn never streamed text.
    fetchStoredVoiceTurn(msg.turnId)
      .then((turn) => sendResponse({ ok: Boolean(turn), turn: turn || null }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error), turn: null }));
    return true;
  }
  if (msg.cmd === "selfExtensionRuntime") {
    refreshSelfExtensionRuntime("content_request")
      .then((runtime) => sendResponse({ ok: true, runtime }))
      .catch(() => sendResponse({ ok: true, runtime: SELF_EXTENSION_RUNTIME_FALLBACK }));
    return true;
  }
  if (msg.cmd === "uiSpec") {
    refreshUiSpec("content_request")
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch(() => sendResponse({ ok: true, ...UI_SPEC_FALLBACK }));
    return true;
  }
  if (msg.cmd === "openOptions") {
    chrome.runtime.openOptionsPage?.().catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (msg.cmd === "activeCompanionPet") {
    loadActiveCompanionPet()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, active_companion: null, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "run" && sender.tab) {
    const tabId = sender.tab.id;
    revokeProactiveGrant(tabId, "another_workflow_started");
    const cueId = nextCueId(msg.cueId);
    claimActiveAgentTab(tabId, "another page agent turn started", {
      cue_id: cueId,
      status: "running",
    });
    const controller = new AbortController();
    tasks.set(cueId, { controller, tabId });
    runAgent(tabId, msg.instruction, controller, cueId, {
      agentRole: msg.agentRole,
      delegationConfirmed: msg.delegationConfirmed === true,
      contextAction: msg.contextAction,
      threadLabel: msg.threadLabel,
    });
  }
  if (msg.cmd === "branch" && sender.tab) {
    // Router intent: launch a disposable task agent in its OWN background tab.
    const overlayTabId = sender.tab.id;
    revokeProactiveGrant(overlayTabId, "another_workflow_started");
    const cueId = nextCueId(msg.cueId);
    claimActiveAgentTab(overlayTabId, "another page agent turn started", {
      cue_id: cueId,
      status: "running",
    });
    const controller = new AbortController();
    tasks.set(cueId, { controller, tabId: overlayTabId });
    runBranchTaskAgent(overlayTabId, msg.instruction, msg.url, controller, cueId);
  }
  if (msg.cmd === "branchFanout" && sender.tab && Array.isArray(msg.branches)) {
    // BRANCH-TO-TWO: one trigger, N concurrent disposable task agents, each its
    // own background tab + own cue + own gateway router activation.
    const overlayTabId = sender.tab.id;
    revokeProactiveGrant(overlayTabId, "another_workflow_started");
    const controllersByCue = new Map();
    const branches = msg.branches.map((b) => {
      const cueId = nextCueId(b.cueId);
      const controller = new AbortController();
      tasks.set(cueId, { controller, tabId: overlayTabId });
      controllersByCue.set(cueId, controller);
      return { instruction: b.instruction, url: b.url, cueId };
    });
    claimActiveAgentTab(overlayTabId, "another page agent turn started", {
      cue_id: branches[0]?.cueId || null,
      status: "running",
    });
    runBranchFanout(overlayTabId, branches, controllersByCue);
  }
  if (msg.cmd === "describe" && sender.tab) {
    const tabId = sender.tab.id;
    revokeProactiveGrant(tabId, "another_workflow_started");
    const cueId = nextCueId(msg.cueId);
    claimActiveAgentTab(tabId, "another page agent turn started", {
      cue_id: cueId,
      status: "running",
    });
    const controller = new AbortController();
    tasks.set(cueId, { controller, tabId });
    describePage(tabId, controller, cueId);
  }
  if (msg.cmd === "cancel" && sender.tab) {
    const tabId = sender.tab.id;
    revokeProactiveGrant(tabId, "manual_stop", false);
    if (msg.cueId && tasks.has(msg.cueId)) {
      tasks.get(msg.cueId).controller.abort();
      tasks.delete(msg.cueId);
    } else {
      cancelTabCues(tabId);
      // A tab-wide stop also cancels any autonomous background agent-loop.
      cancelAgentLoopCues();
    }
  }
  if (msg.cmd === "ambientStart" && sender.tab) {
    const tabId = sender.tab.id;
    revokeProactiveGrant(tabId, "another_workflow_started");
    claimActiveAgentTab(tabId, "another page ambient session started", {
      status: "ambient",
    });
    startAmbientCapture(tabId, msg.intervalMs)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "ambientStop") {
    stopAmbientCapture();
    sendResponse({ ok: true });
    return true;
  }
  // Overlay review surface -> tweaks module. content.js and tweaks.js are separate
  // content scripts in the same tab and cannot message each other directly, so the
  // overlay routes list/remove through the background, which forwards to the
  // tweaks module in the same tab via the existing tweak:* API.
  if (msg.cmd === "tweakList" && sender.tab) {
    ask(sender.tab.id, { cmd: "tweak:list" })
      .then((res) => sendResponse(res || { ok: false, tweaks: [] }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error), tweaks: [] }));
    return true;
  }
  if (msg.cmd === "tweakRemove" && sender.tab) {
    ask(sender.tab.id, { cmd: "tweak:remove", id: msg.id })
      .then((res) => sendResponse(res || { ok: false }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  // A page_tweak action that arrived over the live voice socket is routed here by
  // the overlay content script (content.js cannot message tweaks.js directly).
  // Forward the record to the tweaks module in the same tab via the same
  // tweak:applyRecord message the HTTP turn path uses.
  if (msg.cmd === "tweakApplyRecord" && sender.tab) {
    ask(sender.tab.id, { cmd: "tweak:applyRecord", record: msg.record })
      .then((res) => sendResponse(res || { ok: false, error: "no tweak result" }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
});

// Stop the ambient loop if its tab goes away, so it never posts against a dead tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  revokeProactiveGrant(tabId, "tab_closed", false);
  cancelVoiceSampler(tabId, "tab closed");
  if (ambient && ambient.tabId === tabId) stopAmbientCapture();
  if (activeAgentTabId === tabId) {
    activeAgentTabId = null;
    clearActiveBrowserAgentOwner(tabId, "owner tab closed").catch(() => {});
  }
  closeTabVoiceSessions(tabId);
  closeTabRecordSessions(tabId);
  if (videoNoteSession && videoNoteSession.tabId === tabId) {
    discardVideoNoteSession("tab closed");
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const confirmation of proactiveConfirmations.values()) {
    if (confirmation.window_id !== windowId) continue;
    if (confirmation.state === "consuming") {
      confirmation.window_id = null;
      break;
    }
    if (proactiveGrants.get(confirmation.tab_id) === confirmation.grant) {
      revokeProactiveGrant(confirmation.tab_id, "confirmation_window_closed");
    } else {
      removeProactiveConfirmation(confirmation, "confirmation_window_closed", { notify: true });
    }
    break;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
    revokeProactiveGrant(tabId, "navigation");
  }
});

chrome.action.onClicked.addListener((tab) => {
  // The toolbar icon opens the extension-owned agent panel. Unlike the injected
  // overlay, the side panel renders on every page — chrome:// pages, the Web
  // Store, the PDF viewer — and persists across tab switches. sidePanel.open
  // must be the first synchronous call in this handler: the user-gesture flag
  // for this API decays almost immediately (crbug.com/1478648), so no awaits
  // before it.
  const opened = openAgentPanel(tab);
  if (!opened) summonOverlay(tab, "open");
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if ((command !== "toggle-agee" && command !== "toggle-agee-voice") || !tab?.id) return;
  const cmd = command === "toggle-agee-voice" ? "toggleVoice" : "open";
  // Same restricted-page fallback as the toolbar click: never let the
  // shortcut die silently on a page the overlay cannot inject into.
  if (!isInjectableOverlayUrl(tab.url)) {
    summonOverlay(tab, cmd);
    return;
  }
  try {
    await ensureContent(tab.id);
    await chrome.tabs.sendMessage(tab.id, { cmd, source: "command" });
  } catch {
    summonOverlay(tab, cmd);
  }
});

// ---- System-wide overlay summon (global command) --------------------------
// `open-agee-global` is a global command (manifest "global": true, suggested
// Command+Shift+9). Chrome fires it even when Chrome is not the focused app, so
// a macOS helper — double-tap of the Command key via Karabiner-Elements, see
// scripts/macos-summon/ — can raise the overlay from any application. Unlike the
// per-tab toggle commands, the tab Chrome hands us may be a page the overlay
// cannot inject into (chrome://, the Web Store, a PDF viewer). This path resolves
// an injectable tab in the last-focused window, focuses it, and creates a fresh
// tab only when the browser has no eligible tab at all.
const OVERLAY_FALLBACK_URL = "https://agee.app/";

function isInjectableOverlayUrl(url) {
  if (typeof url !== "string" || !url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // The Chrome Web Store blocks content scripts even over https.
  if (parsed.hostname === "chromewebstore.google.com") return false;
  if (parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore")) return false;
  return true;
}

function mostRecentlyAccessedTab(tabs) {
  return (tabs || [])
    .filter((tab) => tab?.id != null && isInjectableOverlayUrl(tab.url))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}

async function waitForTabComplete(tabId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
    if (tab.status === "complete") return tab;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function resolveOverlayTargetTab(firedTab) {
  // 1. The tab Chrome handed us, if it can host the overlay.
  if (firedTab?.id != null && isInjectableOverlayUrl(firedTab.url)) return firedTab;

  // 2/3. The last-focused normal window: its active tab, else its best tab.
  let lastWindow = null;
  try {
    lastWindow = await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] });
  } catch {
    lastWindow = null;
  }
  const windowActive = lastWindow?.tabs?.find((tab) => tab.active);
  if (windowActive?.id != null && isInjectableOverlayUrl(windowActive.url)) return windowActive;
  const windowBest = mostRecentlyAccessedTab(lastWindow?.tabs);
  if (windowBest) return windowBest;

  // 4. Any injectable tab across all normal windows.
  const anyBest = mostRecentlyAccessedTab(
    await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })
  );
  if (anyBest) return anyBest;

  // 5. Nothing eligible is open: create a fresh injectable tab and wait for it.
  const { ageeOverlayFallbackUrl } = await chrome.storage.local.get({
    ageeOverlayFallbackUrl: OVERLAY_FALLBACK_URL,
  });
  const fallbackUrl = isInjectableOverlayUrl(ageeOverlayFallbackUrl) ? ageeOverlayFallbackUrl : OVERLAY_FALLBACK_URL;
  const created = await chrome.tabs.create({ url: fallbackUrl, active: true });
  return created?.id != null ? await waitForTabComplete(created.id) : null;
}

async function summonOverlayFromAnywhere(firedTab, cmd = "open") {
  const target = await resolveOverlayTargetTab(firedTab);
  if (!target?.id) return;
  // Bring Chrome's window and the target tab forward so the overlay is visible
  // even when the command fired while another application was focused.
  try {
    await chrome.tabs.update(target.id, { active: true });
  } catch {}
  if (target.windowId != null) {
    try {
      await chrome.windows.update(target.windowId, { focused: true, drawAttention: true });
    } catch {}
  }
  try {
    await ensureContent(target.id);
    await chrome.tabs.sendMessage(target.id, { cmd, source: "command" });
  } catch {
    // Restricted browser pages cannot receive content scripts.
  }
}

// A second summon while the first is still resolving (e.g. waiting on a created
// fallback tab to load) would create a duplicate tab, because a still-loading
// tab has no committed url for the query in step 4 to rematch. The same guard
// covers the restricted-page fallback used by the per-tab shortcuts and the
// toolbar click above.
let summonInFlight = false;
function summonOverlay(firedTab, cmd = "open") {
  if (summonInFlight) return;
  summonInFlight = true;
  summonOverlayFromAnywhere(firedTab, cmd)
    .catch(() => {})
    .finally(() => {
      summonInFlight = false;
    });
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "open-agee-global") return;
  summonOverlay(tab, "open");
});

// ---- Side panel agent surface ----------------------------------------------
// The side panel is the extension-owned home of the agent: an extension page
// Chrome renders on every tab — chrome:// pages and the Web Store included —
// that persists across tab switches. It is not a tab, so tabs.sendMessage can
// never reach it; a long-lived port bridges it into the same tab-addressed
// delivery layer the overlay uses. Panel-owned voice sessions carry the
// PANEL_TAB_ID sentinel and send() routes their events over the port. Mic
// capture stays in the offscreen document (extension pages cannot render the
// getUserMedia permission prompt), which is already how overlay voice works.
const PANEL_TAB_ID = -2;
let panelPort = null;

function sendToPanel(msg) {
  if (!panelPort) return;
  try {
    panelPort.postMessage(msg);
  } catch {}
}

function openAgentPanel(tab) {
  if (!chrome.sidePanel?.open) return false;
  const target = tab?.windowId != null
    ? { windowId: tab.windowId }
    : tab?.id != null
      ? { tabId: tab.id }
      : null;
  if (!target) return false;
  chrome.sidePanel.open(target).catch(() => {});
  return true;
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "open-agee-panel") return;
  // Same gesture constraint as the action click: open synchronously, no awaits.
  if (openAgentPanel(tab)) return;
  chrome.windows.getLastFocused((win) => {
    if (win?.id != null) chrome.sidePanel?.open?.({ windowId: win.id }).catch(() => {});
  });
});

function closePanelSessions(reason) {
  for (const [id, session] of [...voiceSessions]) {
    if (session.tabId === PANEL_TAB_ID) closeVoiceSession(id, reason);
  }
  if (activeAgentTabId === PANEL_TAB_ID) {
    activeAgentTabId = null;
    clearActiveBrowserAgentOwner(PANEL_TAB_ID, reason).catch(() => {});
  }
}

async function handlePanelRequest(msg) {
  if (msg.cmd === "browserRoleTurn") {
    const role = normalizeBrowserAgentRole(msg.role);
    if (!role) return { ok: false, error: "Choose Delegate, Help, Collaborate, or Explain." };
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !isInjectableOverlayUrl(tab.url)) {
      return { ok: false, error: "Open a normal web page before starting a browser-agent task." };
    }
    const cfg = await getConfig();
    if (!cfg.gatewayUrl) {
      return { ok: false, error: "No gateway URL set. Open A.G. Options and configure the Agent gateway URL." };
    }
    await ensureContent(tab.id);
    const cueId = nextCueId(msg.cueId || `panel_${Date.now().toString(36)}`);
    const controller = new AbortController();
    tasks.set(cueId, { controller, tabId: tab.id });
    try {
      const data = await runBrowserAgentTurn(tab.id, msg.text, cfg, controller.signal, cueId, {
        input: "text",
        role,
        delivery: "return",
        delegationConfirmed: msg.delegationConfirmed === true,
      });
      return {
        ok: true,
        role,
        summary: browserTurnSummary(data),
        browser_turn_id: browserTurnId(data),
        task_ids: Array.isArray(data?.task_ids) ? data.task_ids : [],
        agent_run_ids: Array.isArray(data?.agent_run_ids) ? data.agent_run_ids : [],
      };
    } finally {
      if (tasks.get(cueId)?.controller === controller) tasks.delete(cueId);
    }
  }
  if (msg.cmd === "voiceSessionStart") {
    if (activeRecordSession()) {
      return { ok: false, error: "An audio note recording is in progress. Stop recording before starting voice." };
    }
    revokeAllProactiveGrants("another_workflow_started");
    claimActiveAgentTab(PANEL_TAB_ID, "panel voice session started", {
      cue_id: msg.cueId || null,
      status: "listening",
    });
    const session = await startVoiceSessionWithMode(PANEL_TAB_ID, {
      cueId: msg.cueId,
      turnId: msg.turnId,
      assistantOverlap: msg.assistantOverlap === true,
      capture: msg.capture === "extension-offscreen" ? "extension-offscreen" : "content-script",
      autoCommit: msg.autoCommit !== false,
      contextAction: msg.contextAction,
      threadLabel: msg.threadLabel,
    });
    if (session?.voiceSessionId) {
      setActiveBrowserAgentOwner(PANEL_TAB_ID, "panel voice session started", {
        cue_id: msg.cueId || null,
        voice_session_id: session.voiceSessionId,
        status: "listening",
      }).catch(() => {});
    }
    return { ok: true, ...session };
  }
  if (msg.cmd === "voiceSessionAttach") {
    return attachVoiceSession(msg.voiceSessionId, PANEL_TAB_ID);
  }
  if (msg.cmd === "voiceSessionControl") {
    return sendVoiceSessionControl(msg.voiceSessionId, msg.message);
  }
  if (msg.cmd === "voiceSessionClose") {
    closeVoiceSession(msg.voiceSessionId, String(msg.reason || "closed"));
    return { ok: true };
  }
  if (msg.cmd === "voiceTurnFetch") {
    const turn = await fetchStoredVoiceTurn(msg.turnId);
    return { ok: Boolean(turn), turn: turn || null };
  }
  if (msg.cmd === "history") {
    const cfg = await getConfig();
    const turns = await loadHistory(cfg);
    return { ok: true, turns };
  }
  return { ok: false, error: `unsupported panel command: ${String(msg.cmd || "")}` };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "agee-panel") return;
  if (panelPort && panelPort !== port) {
    try {
      panelPort.disconnect();
    } catch {}
  }
  panelPort = port;
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object" || msg.reqId == null) return;
    Promise.resolve()
      .then(() => handlePanelRequest(msg))
      .then((result) => {
        try {
          port.postMessage({ reqId: msg.reqId, ...(result || { ok: false, error: "empty panel response" }) });
        } catch {}
      })
      .catch((error) => {
        try {
          port.postMessage({ reqId: msg.reqId, ok: false, error: String(error?.message || error) });
        } catch {}
      });
  });
  port.onDisconnect.addListener(() => {
    if (panelPort === port) panelPort = null;
    closePanelSessions("panel closed");
  });
});
