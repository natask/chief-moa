"use strict";

const { PROFILE_FIELDS } = require("./agent-profile");

const DEFINITIONS = Object.freeze({
  system_prompt: define("System prompt", "behavior", "Standing instructions that shape the agent's behavior.", ["instructions", "behavior", "persona"], "Change this when you want durable behavioral instructions."),
  assistant_name: define("Assistant name", "identity", "The name the assistant uses for itself.", ["name", "identity", "call yourself"], "Change this when you want the assistant to use a different name."),
  user_address: define("Form of address", "identity", "The title or form of address the assistant uses for the user.", ["title", "honorific", "address me"], "Change this when you want a particular title or form of address."),
  user_name: define("User name", "identity", "The user's configured name.", ["my name", "owner name"], "Change this when the assistant should know your name."),
  user_nickname: define("User nickname", "identity", "The user's preferred nickname.", ["nickname", "call me"], "Change this when you prefer a nickname."),
  model: define("Reasoning model", "model", "The gateway model identifier used for reasoning.", ["llm", "model id", "intelligence"], "Change this when selecting a different configured reasoning model.", "text"),
  temperature: define("Temperature", "model", "Sampling temperature for model responses, from 0 to 2.", ["randomness", "creativity", "deterministic"], "Lower values are steadier; higher values are more varied.", "number", { minimum: 0, maximum: 2 }),
  voice_max_chars: define("Spoken reply limit", "voice", "Maximum characters spoken in one reply.", ["terse", "concise", "short reply", "verbose", "length"], "Lower this for shorter spoken answers; raise it for more detail.", "integer", { minimum: 1 }),
  language: define("Reply languages", "language", "BCP-47 languages the assistant may use in replies.", ["output language", "speak", "reply in"], "Use this to choose the language or languages the assistant replies in.", "language_list"),
  voice: define("Voice", "voice", "Catalog-backed speaking voice used for synthesized replies.", ["speaker", "sound", "masculine", "feminine"], "Change this when you want a different speaking voice.", "enum"),
  speaking_rate: define("Speaking rate", "voice", "Speech speed multiplier from 0.5 to 2.", ["voice speed", "speech speed", "faster", "slower", "pace"], "Change this when speech is too fast or too slow.", "number", { minimum: 0.5, maximum: 2 }),
  voice_tone: define("Voice tone", "voice", "Short description of the desired speaking mood.", ["mood", "warm", "upbeat", "calm"], "Change this when you want a different vocal mood.", "text"),
  language_mode: define("Language mode", "language", "Whether reply language selection is explicit or automatic.", ["language detection", "automatic language"], "Use explicit mode when language selection must remain fixed.", "enum", { values: ["explicit", "auto"] }),
  language_primary: define("Primary reply language", "language", "The preferred first BCP-47 reply language.", ["default reply language", "main output language"], "Change this to lead replies with one configured reply language.", "language_code"),
  language_output: define("Language output policy", "language", "Policy controlling how configured reply languages are used.", ["multilingual reply", "primary only"], "Use this to control whether replies stay in the primary language.", "enum", { values: ["primary_only", "auto"] }),
  language_auto_switch: define("Automatic reply-language switching", "language", "Whether replies may switch among configured languages.", ["lock language", "do not switch", "multilingual"], "Disable this when replies must stay in the selected language.", "boolean"),
  input_languages: define("Understood languages", "language", "BCP-47 languages the speech recognizer listens for.", ["heard language", "listen", "understand", "speech recognition languages", "languages I speak"], "Change this to match the languages you speak to the assistant.", "language_list"),
  input_language_primary: define("Primary understood language", "language", "The configured input language that leads speech recognition.", ["speaking now", "recognition priority", "main input language"], "Change this when one understood language should lead recognition now.", "language_code"),
  response_modality: define("Response modality", "voice", "Whether replies are delivered as speech, text, or automatically selected.", ["speak replies", "text only", "silent", "delivery"], "Choose text when you do not want spoken replies and speech when you do.", "enum", { values: ["auto", "speech", "text"] }),
  voice_provider: define("Voice pipeline", "provider", "Configured gateway voice pipeline.", ["voice provider", "live voice", "cascaded"], "Change this only when selecting an available gateway voice pipeline.", "text"),
  stt_provider: define("Speech recognition provider", "provider", "Gateway provider used to transcribe speech.", ["stt", "transcription", "speech to text"], "Change this only when another speech-recognition provider is configured.", "text"),
  reasoning_provider: define("Reasoning provider", "provider", "Gateway provider used for language-model reasoning.", ["model provider", "llm provider", "openai", "gemini", "anthropic"], "Change this when selecting another configured reasoning provider.", "text"),
  tts_provider: define("Speech synthesis provider", "provider", "Gateway provider used to synthesize speech.", ["tts", "text to speech", "speech provider"], "Change this only when another speech-synthesis provider is configured.", "text"),
  tool_policy: define("Tool policy", "authority", "Policy limiting how the agent may use tools.", ["tools", "actions", "proposal only", "permissions"], "Review this when you want to understand tool-use limits.", "text"),
  autonomy_level: define("Autonomy level", "authority", "Policy controlling when actions require confirmation.", ["approval", "confirm actions", "automatic actions"], "Review this when you want to understand action confirmation behavior.", "text"),
  memory_policy: define("Memory policy", "memory", "Policy controlling durable recall and memory writes.", ["remember", "forget", "recall", "personalization"], "Change this when you want different durable-memory behavior.", "text"),
  recovery_mode: define("Recovery mode", "reliability", "Gateway recovery behavior for failed or interrupted work.", ["retry", "failure", "resume"], "Review this when diagnosing how interrupted work recovers.", "text"),
  active_companion_id: define("Active companion id", "companion", "Stable identifier of the active companion profile.", ["companion", "persona id"], "Read this to identify the active companion.", "text", { managed: true }),
  active_companion_name: define("Active companion name", "companion", "Display name of the active companion profile.", ["companion", "persona name"], "Read this to see which companion is active.", "text", { managed: true }),
  active_companion_source: define("Active companion source", "companion", "Origin of the active companion profile.", ["companion origin", "persona source"], "Read this to understand where the active companion came from.", "text", { managed: true }),
  active_companion_version: define("Active companion version", "companion", "Version of the active companion profile.", ["companion revision", "persona version"], "Read this when checking companion provenance or rollback.", "text", { managed: true }),
});

function define(title, category, description, aliases, recommendation, type = "text", constraints = {}) {
  return Object.freeze({ title, category, description, aliases: Object.freeze(aliases), recommendation, type, ...constraints });
}

const definitionFields = Object.keys(DEFINITIONS).sort();
const canonicalFields = PROFILE_FIELDS.slice().sort();
if (JSON.stringify(definitionFields) !== JSON.stringify(canonicalFields)) {
  throw new Error("profile settings catalog must describe every canonical profile field exactly once");
}

function createProfileSettingsCatalog({ agentProfile, optionsPayload = () => ({}) }) {
  if (!agentProfile || typeof agentProfile.effective !== "function" || typeof agentProfile.defaults !== "function") {
    throw new Error("agentProfile with effective() and defaults() is required");
  }

  function list(options = {}) {
    const context = profileContext(options);
    return PROFILE_FIELDS.map((id) => settingRecord(id, context));
  }

  function get(id, options = {}) {
    const key = normalizeId(id);
    if (!PROFILE_FIELDS.includes(key)) return null;
    return settingRecord(key, profileContext(options));
  }

  function search(query, options = {}) {
    const normalized = normalizeQuery(query);
    if (!normalized) return list(options);
    const terms = normalized.split(" ").filter(Boolean);
    return list(options)
      .map((setting) => ({ setting, score: scoreSetting(setting, normalized, terms) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.setting.id.localeCompare(right.setting.id))
      .slice(0, boundedLimit(options.limit))
      .map(({ setting, score }) => ({ ...setting, match: { score, reason: matchReason(setting, terms) } }));
  }

  function recommend(query, options = {}) {
    return search(query, { ...options, limit: options.limit || 5 }).map((setting) => ({
      ...setting,
      recommendation: DEFINITIONS[setting.id].recommendation,
    }));
  }

  function profileContext(options) {
    const profileOptions = {
      scope: options.scope === "device" && options.deviceId ? "device" : "global",
      deviceId: options.deviceId || options.device_id || "",
    };
    return {
      profile: agentProfile.effective(profileOptions),
      defaults: agentProfile.defaults(),
      version: typeof agentProfile.currentVersion === "function" ? agentProfile.currentVersion(profileOptions) : "",
      scope: profileOptions.scope,
      deviceId: profileOptions.deviceId,
      options: optionsPayload() || {},
    };
  }

  function settingRecord(id, context) {
    const definition = DEFINITIONS[id];
    const catalogField = context.options?.fields?.[id] || {};
    const values = catalogValues(id, definition, context.options, catalogField);
    const sensitivity = secretLike(id) ? "secret" : (identityLike(id) ? "private" : "normal");
    return {
      id,
      title: definition.title,
      description: definition.description,
      category: definition.category,
      aliases: definition.aliases.slice(),
      type: catalogField.type || definition.type,
      ...(values.length > 0 ? { values } : {}),
      ...(definition.minimum !== undefined ? { minimum: definition.minimum } : {}),
      ...(definition.maximum !== undefined ? { maximum: definition.maximum } : {}),
      readable: true,
      writable: true,
      managed: definition.managed === true,
      scope: context.scope,
      profile_version: context.version,
      sensitivity,
      redacted: sensitivity === "secret",
      value: publicValue(id, context.profile[id]),
      default_value: publicValue(id, context.defaults[id]),
      overridden: !sameValue(context.profile[id], context.defaults[id]),
    };
  }

  return { list, get, search, recommend };
}

function catalogValues(id, definition, payload, catalogField) {
  if (Array.isArray(catalogField.values) && catalogField.values.length > 0) return catalogField.values.slice();
  if (id === "voice" && Array.isArray(payload.voices)) return payload.voices.map((item) => item.id).filter(Boolean);
  if ((id === "language" || id === "input_languages" || id.endsWith("_language_primary")) && Array.isArray(payload.languages)) {
    return payload.languages.map((item) => item.code).filter(Boolean);
  }
  return Array.isArray(definition.values) ? definition.values.slice() : [];
}

function scoreSetting(setting, normalized, terms) {
  const id = setting.id.replace(/_/g, " ");
  const title = normalizeQuery(setting.title);
  const aliases = setting.aliases.map(normalizeQuery);
  const body = normalizeQuery(`${setting.description} ${setting.category} ${aliases.join(" ")}`);
  let score = 0;
  if (id === normalized || title === normalized) score += 100;
  if (id.includes(normalized) || title.includes(normalized)) score += 40;
  if (aliases.some((alias) => normalized.includes(alias) || alias.includes(normalized))) score += 36;
  for (const term of terms) {
    if (id.split(" ").includes(term)) score += 18;
    if (title.split(" ").includes(term)) score += 16;
    if (aliases.some((alias) => alias.includes(term))) score += 12;
    if (body.includes(term)) score += 4;
  }
  return score;
}

function matchReason(setting, terms) {
  const aliases = setting.aliases.map(normalizeQuery);
  const alias = aliases.find((value) => terms.some((term) => value.includes(term)));
  if (alias) return `matched alias: ${alias}`;
  if (terms.some((term) => normalizeQuery(setting.title).includes(term))) return `matched title: ${setting.title}`;
  return `matched ${setting.category} setting description`;
}

function publicValue(id, value) {
  if (secretLike(id) && value !== undefined && value !== null && String(value) !== "") return "[redacted]";
  return value === undefined ? null : value;
}

function secretLike(id) {
  return /(?:^|_)(?:token|secret|password|api_key|credential)(?:_|$)/.test(String(id || ""));
}

function identityLike(id) {
  return ["system_prompt", "user_address", "user_name", "user_nickname"].includes(id);
}

function normalizeId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeQuery(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function boundedLimit(value) {
  return Math.max(1, Math.min(Number(value || 20) || 20, PROFILE_FIELDS.length));
}

function sameValue(left, right) {
  return JSON.stringify(left === undefined ? null : left) === JSON.stringify(right === undefined ? null : right);
}

module.exports = {
  DEFINITIONS,
  createProfileSettingsCatalog,
  normalizeQuery,
  publicValue,
  secretLike,
};
