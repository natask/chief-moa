const OPERATIONS = Object.freeze(["list", "get", "search", "recommend"]);
const MAX_RESULTS = 20;
const MAX_LIST_RESULTS = 100;

const DEFINITIONS = Object.freeze([
  define({
    id: "browser.gateway_url",
    title: "Agent gateway URL",
    category: "connection",
    description: "The gateway origin this browser uses for agent, voice, and settings requests.",
    aliases: ["server", "engine", "endpoint", "connection"],
    defaultValue: "https://api.agee.app",
    constraints: ["HTTPS, or HTTP on localhost/private development networks."],
    takesEffect: "next gateway request",
    writable: true,
  }),
  define({
    id: "browser.gateway_token",
    title: "Gateway token",
    category: "connection",
    description: "Whether this browser has a gateway session token configured. The token value is never returned.",
    aliases: ["authentication", "login", "credential", "secret", "privacy"],
    defaultValue: "not configured",
    constraints: ["Secret value stays in browser-local storage and is always redacted."],
    takesEffect: "next gateway request",
    redaction: "configured state only",
    writable: true,
  }),
  define({
    id: "browser.livekit_voice",
    title: "LiveKit voice transport",
    category: "voice",
    description: "Whether browser voice first tries the experimental LiveKit transport before the standard gateway voice path.",
    aliases: ["experimental voice", "webrtc", "voice connection", "audio transport"],
    defaultValue: false,
    constraints: ["Experimental; failure falls back to the standard WebSocket voice path."],
    takesEffect: "next voice session",
    allowedValues: [false, true],
    writable: true,
  }),
  define({
    id: "browser.background_automation",
    title: "Background browser automation",
    category: "authority",
    description: "Whether this browser may claim gateway-queued work and run bounded browser actions in the background.",
    aliases: ["delegate", "autonomy", "background tasks", "browser actions", "privacy", "permissions"],
    defaultValue: false,
    constraints: ["Requires current versioned user consent.", "Turning it off stops new claims without stranding already-claimed work."],
    takesEffect: "next background claim",
    allowedValues: [false, true],
    mutability: "explicit user consent only",
    writable: true,
    writeRequires: "versioned explicit approval",
  }),
  define({
    id: "browser.microphone_permission",
    title: "Microphone permission",
    category: "permission",
    description: "Chrome permission allowing the A.G. extension origin to capture microphone audio for browser voice.",
    aliases: ["mic", "audio access", "voice permission", "cannot hear", "privacy"],
    defaultValue: "prompt",
    constraints: ["Only the user can grant or change this Chrome permission."],
    takesEffect: "next voice capture",
    allowedValues: ["granted", "denied", "prompt", "unknown"],
    mutability: "user action only",
    deepLink: { target: "microphone_permission", label: "Open microphone setup" },
  }),
  define({
    id: "browser.agent_role",
    title: "Browser agent role",
    category: "agent",
    description: "The persisted role selected for browser turns in the overlay and side panel.",
    aliases: ["delegate", "help", "collaborate", "explain", "browser mode", "agent mode"],
    defaultValue: "delegate",
    constraints: ["Controls browser-turn posture; it does not bypass typed action authority or approval."],
    takesEffect: "next browser turn",
    allowedValues: ["delegate", "help", "collaborate", "explain"],
    writable: true,
  }),
]);

function define(input) {
  return Object.freeze({
    ...input,
    owner: "browser_extension",
    scope: "this browser",
    redaction: input.redaction || "none",
    mutability: input.mutability || "user configurable",
    writable: input.writable === true,
    writeRequires: input.writeRequires || "none",
  });
}

function browserSettings(state = {}) {
  const current = {
    "browser.gateway_url": String(state.gatewayUrl || ""),
    "browser.gateway_token": state.gatewayTokenConfigured ? "configured (value redacted)" : "not configured",
    "browser.livekit_voice": state.livekitVoiceEnabled === true,
    "browser.background_automation": state.backgroundAutomationEnabled === true && state.backgroundAutomationConsentCurrent === true,
    "browser.microphone_permission": normalizePermission(state.microphonePermission),
    "browser.agent_role": normalizeAgentRole(state.agentRole),
  };
  return DEFINITIONS.map((definition) => ({
    id: definition.id,
    title: definition.title,
    category: definition.category,
    owner: definition.owner,
    scope: definition.scope,
    description: definition.description,
    aliases: definition.aliases.slice(),
    current: current[definition.id],
    default: definition.defaultValue,
    constraints: definition.constraints.slice(),
    takes_effect: definition.takesEffect,
    redaction: definition.redaction,
    mutability: definition.mutability,
    writable: definition.writable,
    write_requires: definition.writeRequires,
    ...(definition.allowedValues ? { allowed_values: definition.allowedValues.slice() } : {}),
    ...(definition.deepLink ? { deep_link: { ...definition.deepLink } } : {}),
  }));
}

function readBrowserSettings(args = {}, state = {}) {
  const operation = String(args.operation || (args.id ? "get" : args.query ? "search" : "list")).toLowerCase();
  if (!OPERATIONS.includes(operation)) {
    return { ok: false, error: "unknown_settings_operation", supported_operations: OPERATIONS.slice() };
  }
  const settings = browserSettings(state);
  if (operation === "get") {
    const id = String(args.id || "").trim().toLowerCase();
    const setting = settings.find((item) => item.id === id);
    return setting ? { ok: true, operation, setting } : { ok: false, error: "unknown_setting", setting_id: id };
  }
  const query = normalizeQuery(args.query);
  if ((operation === "search" || operation === "recommend") && !query) {
    return { ok: false, error: "settings_query_required", operation };
  }
  const maximum = operation === "list" ? MAX_LIST_RESULTS : MAX_RESULTS;
  const requestedLimit = args.limit == null ? maximum : Number(args.limit);
  const limit = Math.max(1, Math.min(requestedLimit || maximum, maximum));
  const offset = operation === "list"
    ? Math.max(0, Math.min(Number(args.offset || 0) || 0, settings.length))
    : 0;
  const results = operation === "list"
    ? settings.slice(offset, offset + limit)
    : settings
      .map((setting) => ({ setting, score: scoreSetting(setting, query) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.setting.id.localeCompare(right.setting.id))
      .slice(0, operation === "recommend" ? Math.min(limit, 5) : limit)
      .map(({ setting, score }) => ({
        ...setting,
        match: { score, reason: `matched registered ${setting.category} setting` },
        ...(operation === "recommend" ? { recommendation: recommendationFor(setting) } : {}),
      }));
  return {
    ok: true,
    operation,
    query,
    count: results.length,
    total: operation === "list" ? settings.length : results.length,
    offset,
    next_offset: operation === "list" && offset + results.length < settings.length
      ? offset + results.length
      : null,
    settings: results,
  };
}

function normalizeGatewaySetting(setting) {
  if (!setting || typeof setting !== "object" || !setting.id) return null;
  const constraints = [];
  if (setting.minimum !== undefined) constraints.push(`Minimum: ${setting.minimum}`);
  if (setting.maximum !== undefined) constraints.push(`Maximum: ${setting.maximum}`);
  if (Array.isArray(setting.values) && setting.values.length) constraints.push(`Allowed values: ${setting.values.join(", ")}`);
  return {
    id: `gateway.${setting.id}`,
    gateway_id: setting.id,
    title: setting.title || setting.id,
    category: setting.category || "gateway",
    owner: "gateway",
    scope: setting.scope || "global",
    description: setting.description || "Gateway-owned agent setting.",
    aliases: Array.isArray(setting.aliases) ? setting.aliases.slice() : [],
    current: setting.redacted ? (setting.value ? "configured (value redacted)" : "not configured") : setting.value,
    default: setting.redacted ? (setting.default_value ? "configured (value redacted)" : "not configured") : setting.default_value,
    constraints,
    takes_effect: "next admitted turn",
    redaction: setting.redacted ? "value redacted" : "none",
    mutability: setting.writable === false || setting.managed ? "gateway managed" : "user configurable through gateway profile",
    writable: setting.writable !== false && setting.managed !== true,
    write_requires: "gateway profile validation",
    ...(setting.recommendation ? { recommendation: setting.recommendation } : {}),
    ...(setting.match ? { match: setting.match } : {}),
  };
}

function mergeSettingsResults(localSettings, gatewaySettings, { operation = "search", limit = MAX_RESULTS } = {}) {
  const merged = [...(Array.isArray(localSettings) ? localSettings : []), ...(Array.isArray(gatewaySettings) ? gatewaySettings : [])];
  if (operation === "list") return merged.slice(0, MAX_LIST_RESULTS);
  const bounded = Math.max(1, Math.min(Number(limit) || MAX_RESULTS, MAX_RESULTS));
  return merged.slice(0, bounded);
}

function normalizePermission(value) {
  return ["granted", "denied", "prompt"].includes(value) ? value : "unknown";
}

function normalizeAgentRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return ["delegate", "help", "collaborate", "explain"].includes(role) ? role : "delegate";
}

function parseSettingsQueryIntent(text) {
  const raw = String(text || "").trim();
  const lower = normalizeQuery(raw);
  if (!lower || !/\b(settings?|preferences?|configuration)\b/.test(lower)) return null;
  if (/\b(set|change|update|enable|disable|turn on|turn off|clear)\b/.test(lower)) return null;
  const canonical = raw.match(/\b((?:browser|gateway)\.[a-z0-9_]+)\b/i)?.[1]?.toLowerCase();
  if (canonical && /\b(get|show|explain|what|which|tell)\b/.test(lower)) {
    return { operation: "get", id: canonical, query: "" };
  }
  if (/\b(all|every|everything|complete|full)\b/.test(lower) || /\b(list|show|tell me)\b.*\bsettings?\b/.test(lower)) {
    return { operation: "list", query: "" };
  }
  const operation = /\b(recommend|useful|best|help(?:ful)?|should i)\b/.test(lower) ? "recommend" : "search";
  const query = lower
    .replace(/\b(?:find|search|show|list|tell me|what|which|are|is|the|my|all|settings?|preferences?|configuration|recommend|recommended|useful|best|for|about|related to)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return query ? { operation, query } : { operation: "list", query: "" };
}

function parseBrowserSettingWriteIntent(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let match = raw.match(/\b(?:set|change|update)\s+(?:the\s+)?(?:agent\s+)?gateway\s+(?:url|origin|endpoint)\s+(?:to|=|:)\s*(\S+)\s*$/i);
  if (match) return { id: "browser.gateway_url", value: match[1] };
  match = raw.match(/\b(?:set|change|update)\s+(?:the\s+)?gateway\s+(?:token|session token)\s+(?:to|=|:)\s*(.+)$/i);
  if (match) return { id: "browser.gateway_token", value: match[1].trim() };
  if (/\b(?:clear|remove|forget)\s+(?:the\s+)?gateway\s+(?:token|session token)\b/i.test(raw)) {
    return { id: "browser.gateway_token", value: "" };
  }
  match = raw.match(/\b(?:set|change|switch)\s+(?:the\s+)?browser\s+(?:agent\s+)?(?:role|mode)\s+(?:to|=|:)\s*(delegate|help|collaborate|explain)\b/i);
  if (match) return { id: "browser.agent_role", value: match[1].toLowerCase() };
  if (/\b(?:enable|turn on|use)\b.*\blivekit\b/i.test(raw)) return { id: "browser.livekit_voice", value: true };
  if (/\b(?:disable|turn off|stop using)\b.*\blivekit\b/i.test(raw)) return { id: "browser.livekit_voice", value: false };
  if (/\b(?:enable|turn on|allow)\b.*\bbackground (?:browser )?automation\b/i.test(raw)) {
    return { id: "browser.background_automation", value: true };
  }
  if (/\b(?:disable|turn off|stop)\b.*\bbackground (?:browser )?automation\b/i.test(raw)) {
    return { id: "browser.background_automation", value: false };
  }
  return null;
}

function validateBrowserSettingWrite(args = {}) {
  const id = String(args.id || "").trim().toLowerCase();
  const definition = DEFINITIONS.find((item) => item.id === id);
  if (!definition) return { ok: false, error: "unknown_setting", setting_id: id };
  if (!definition.writable) return { ok: false, error: "setting_not_writable", setting_id: id };
  const value = args.value;
  if (id === "browser.gateway_url" || id === "browser.gateway_token") {
    if (typeof value !== "string" || value.length > 4096) return { ok: false, error: "invalid_setting_value", setting_id: id };
  } else if (id === "browser.livekit_voice" || id === "browser.background_automation") {
    if (typeof value !== "boolean") return { ok: false, error: "invalid_setting_value", setting_id: id };
    if (id === "browser.background_automation" && value === true) {
      const approval = args.approval;
      if (approval?.approved !== true || approval?.setting_id !== id || approval?.consent_version !== 1) {
        return { ok: false, error: "explicit_versioned_approval_required", setting_id: id, consent_version: 1 };
      }
    }
  } else if (id === "browser.agent_role") {
    if (!["delegate", "help", "collaborate", "explain"].includes(String(value || "").toLowerCase())) {
      return { ok: false, error: "invalid_setting_value", setting_id: id };
    }
  }
  return { ok: true, id, value };
}

function normalizeQuery(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreSetting(setting, query) {
  const terms = query.split(" ").filter(Boolean);
  const id = normalizeQuery(setting.id);
  const title = normalizeQuery(setting.title);
  const aliases = setting.aliases.map(normalizeQuery);
  const body = normalizeQuery(`${setting.category} ${setting.description} ${setting.constraints.join(" ")} ${aliases.join(" ")}`);
  let score = 0;
  if (id === query || title === query) score += 100;
  if (id.includes(query) || title.includes(query)) score += 40;
  if (aliases.some((alias) => alias.includes(query) || query.includes(alias))) score += 32;
  for (const term of terms) {
    if (id.includes(term)) score += 18;
    if (title.includes(term)) score += 16;
    if (aliases.some((alias) => alias.includes(term))) score += 12;
    if (body.includes(term)) score += 4;
  }
  return score;
}

function recommendationFor(setting) {
  if (setting.id === "browser.microphone_permission") return "Review this when browser voice cannot capture audio.";
  if (setting.id === "browser.background_automation") return "Review this when deciding whether delegated browser work may continue in the background.";
  if (setting.id === "browser.livekit_voice") return "Review this only when testing the experimental browser voice transport.";
  if (setting.id === "browser.gateway_token") return "Review configured state when the gateway rejects authenticated requests.";
  return "Review this when changing which gateway this browser uses.";
}

export {
  DEFINITIONS,
  OPERATIONS,
  browserSettings,
  mergeSettingsResults,
  normalizeGatewaySetting,
  parseBrowserSettingWriteIntent,
  parseSettingsQueryIntent,
  readBrowserSettings,
  validateBrowserSettingWrite,
};
