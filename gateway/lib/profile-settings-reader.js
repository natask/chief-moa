"use strict";

const OPERATIONS = Object.freeze(["list", "get", "search", "recommend", "compare"]);

function createProfileSettingsReader(settingsCatalog) {
  if (!settingsCatalog) throw new Error("settingsCatalog is required");

  return function readAgentSettings(args = {}, context = {}) {
    const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const operation = requestedOperation(input);
    if (!OPERATIONS.includes(operation)) {
      return { ok: false, error: "unknown_settings_operation", operation, supported_operations: OPERATIONS.slice() };
    }
    if (input.scope === "device" && !context.deviceId) {
      return { ok: false, error: "device_id_required_for_device_scope" };
    }
    const options = {
      scope: input.scope === "device" && context.deviceId ? "device" : "global",
      deviceId: context.deviceId || "",
      limit: input.limit,
    };
    if (operation === "get") {
      const id = String(input.id || input.setting_id || "").trim();
      if (!id) return { ok: false, error: "setting_id_required" };
      const setting = settingsCatalog.get(id, options);
      return setting
        ? { ok: true, type: "agent_setting", setting }
        : { ok: false, error: "unknown_setting", setting_id: id };
    }
    const query = String(input.query || input.q || input.intent || "").trim();
    if ((operation === "search" || operation === "recommend") && !query) {
      return { ok: false, error: "settings_query_required", operation };
    }
    const settings = operation === "list"
      ? settingsCatalog.list(options)
      : operation === "compare"
        ? settingsCatalog.compare(options)
        : settingsCatalog[operation](query, options);
    return {
      ok: true,
      type: operation === "recommend" ? "agent_settings_recommendations"
        : operation === "compare" ? "agent_settings_comparison" : "agent_settings",
      operation,
      query,
      count: settings.length,
      settings,
    };
  };
}

function requestedOperation(input) {
  const explicit = String(input.operation || input.action || input.mode || "").trim().toLowerCase();
  if (explicit) return explicit;
  if (input.id || input.setting_id) return "get";
  if (input.query || input.q || input.intent) return "search";
  return "list";
}

function readAgentSettingsTool(handler) {
  return {
    name: "read_agent_settings",
    description: "Read only the gateway's canonical existing settings catalog. operation=list returns every setting and current/default values; get reads one exact id; search finds settings by meaning/aliases; recommend ranks relevant existing settings for a goal; compare returns settings whose current values differ from defaults. Never invent a setting. This tool cannot write. Secret values, if any, are redacted.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: OPERATIONS.slice() },
        id: { type: "string", description: "Exact catalog setting id for get." },
        query: { type: "string", description: "Natural-language goal for search or recommend." },
        scope: { type: "string", enum: ["global", "device"] },
        limit: { type: "integer", minimum: 1, maximum: 31 },
      },
    },
    handler,
  };
}

function readAgentSettingsGeminiDeclaration() {
  return {
    name: "read_agent_settings",
    description: "Read only the canonical existing gateway settings. Use list to enumerate all settings, get for an exact id, search to find settings by meaning, recommend to rank existing settings for a goal, or compare to return current values that differ from defaults. Never invent a setting. This cannot write, and secret values are redacted.",
    parameters: {
      type: "OBJECT",
      properties: {
        operation: { type: "STRING", description: "list, get, search, recommend, or compare" },
        id: { type: "STRING", description: "Exact setting id for get." },
        query: { type: "STRING", description: "Natural-language goal for search or recommend." },
        scope: { type: "STRING", description: "global or device" },
        limit: { type: "INTEGER", description: "Maximum results, from 1 to 31." },
      },
    },
  };
}

module.exports = { OPERATIONS, createProfileSettingsReader, readAgentSettingsTool, readAgentSettingsGeminiDeclaration, requestedOperation };
