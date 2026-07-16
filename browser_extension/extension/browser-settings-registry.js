const OPERATIONS = Object.freeze(["list", "get", "search", "recommend"]);
const MAX_RESULTS = 20;

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
]);

function define(input) {
  return Object.freeze({
    ...input,
    owner: "browser_extension",
    scope: "this browser",
    redaction: input.redaction || "none",
    mutability: input.mutability || "user configurable",
  });
}

function browserSettings(state = {}) {
  const current = {
    "browser.gateway_url": String(state.gatewayUrl || ""),
    "browser.gateway_token": state.gatewayTokenConfigured ? "configured (value redacted)" : "not configured",
    "browser.livekit_voice": state.livekitVoiceEnabled === true,
    "browser.background_automation": state.backgroundAutomationEnabled === true && state.backgroundAutomationConsentCurrent === true,
    "browser.microphone_permission": normalizePermission(state.microphonePermission),
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
  const limit = Math.max(1, Math.min(Number(args.limit || MAX_RESULTS) || MAX_RESULTS, MAX_RESULTS));
  const results = operation === "list"
    ? settings.slice(0, limit)
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
  return { ok: true, operation, query, count: results.length, settings: results };
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
    mutability: setting.managed ? "gateway managed" : "user configurable through gateway profile",
    ...(setting.recommendation ? { recommendation: setting.recommendation } : {}),
    ...(setting.match ? { match: setting.match } : {}),
  };
}

function normalizePermission(value) {
  return ["granted", "denied", "prompt"].includes(value) ? value : "unknown";
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
  normalizeGatewaySetting,
  readBrowserSettings,
};
