"use strict";

function createProfileHandlers({
  agentProfile, authorizedAgent, agentAuthError, readJsonBody, sendJson, cleanError,
  profileOptionsFromUrl, profileOptionsFromBody, requireDeviceScope,
  agentProfilePayload, readProfileHistory, recordProfileHistory,
  rejectedLanguageFields, supportedLanguagesSentence, profileApplicationSemantics,
  settingsCatalog, providerCatalog, resolveProviderSelection,
}) {
  function authorize(request, response) {
    if (authorizedAgent(request)) return true;
    sendJson(response, 401, agentAuthError());
    return false;
  }

  async function putProfile(request, response) {
    const body = await readJsonBody(request);
    const patch = body && typeof body === "object" ? (body.profile || body.profile_overrides || body) : {};
    const unknownFields = unknownProfileFields(body, patch, agentProfile.fields());
    if (unknownFields.length > 0) {
      sendJson(response, 400, {
        error: "unknown_profile_fields",
        unknown_fields: unknownFields,
        supported_fields: agentProfile.fields(),
      });
      return;
    }
    const profileOptions = profileOptionsFromBody(body, "global");
    if (!requireDeviceScope(response, profileOptions)) return;
    const before = agentProfile.effective(profileOptions);
    const beforeVersion = agentProfile.currentVersion(profileOptions);
    try {
      agentProfile.patch(patch, { source: body?.source || "api", reason: "patch",
        scope: profileOptions.scope, deviceId: profileOptions.deviceId });
    } catch (error) {
      if (!sendProviderSelectionError(response, error)) throw error;
      return;
    }
    const after = agentProfile.effective(profileOptions);
    const afterVersion = agentProfile.currentVersion(profileOptions);
    recordProfileHistory(before, after, body?.source, { beforeVersion, afterVersion,
      scope: profileOptions.scope, deviceId: profileOptions.deviceId });
    const rejectedLanguages = rejectedLanguageFields(patch);
    const extra = { application: profileApplicationSemantics() };
    if (rejectedLanguages.length > 0) {
      const supported = supportedLanguagesSentence();
      extra.language_rejection = { fields: rejectedLanguages, supported,
        message: `That language is not in the supported set (${supported}), so I kept the previous language.` };
    }
    sendJson(response, 200, agentProfilePayload(extra, profileOptions));
  }

  async function putProviderSelection(request, response) {
    const body = await readJsonBody(request);
    const profileOptions = profileOptionsFromBody(body, "global");
    if (!requireDeviceScope(response, profileOptions)) return;
    const before = agentProfile.effective(profileOptions);
    const beforeVersion = agentProfile.currentVersion(profileOptions);
    try {
      const selection = resolveProviderSelection(body, { profile: before });
      agentProfile.patch(selection.patch, { source: body?.source || "api", reason: "provider_selection",
        scope: profileOptions.scope, deviceId: profileOptions.deviceId });
      const after = agentProfile.effective(profileOptions);
      const afterVersion = agentProfile.currentVersion(profileOptions);
      recordProfileHistory(before, after, body?.source || "provider_selection", { beforeVersion, afterVersion,
        scope: profileOptions.scope, deviceId: profileOptions.deviceId });
      sendJson(response, 200, agentProfilePayload({ selection: selection.choice,
        application: profileApplicationSemantics() }, profileOptions));
    } catch (error) {
      if (!sendProviderSelectionError(response, error)) throw error;
    }
  }

  async function resetProfile(request, response) {
    const body = await readJsonBody(request);
    const profileOptions = profileOptionsFromBody(body, "global");
    if (!requireDeviceScope(response, profileOptions)) return;
    const before = agentProfile.effective(profileOptions);
    const beforeVersion = agentProfile.currentVersion(profileOptions);
    agentProfile.reset({ source: body?.source || "api", reason: "reset",
      scope: profileOptions.scope, deviceId: profileOptions.deviceId });
    const after = agentProfile.effective(profileOptions);
    const afterVersion = agentProfile.currentVersion(profileOptions);
    recordProfileHistory(before, after, body?.source || "reset", { beforeVersion, afterVersion,
      scope: profileOptions.scope, deviceId: profileOptions.deviceId });
    sendJson(response, 200, agentProfilePayload({ application: profileApplicationSemantics() }, profileOptions));
  }

  async function rollbackProfile(request, response) {
    const body = await readJsonBody(request);
    const version = body?.version || body?.profile_version || body?.rollback_to_version;
    try {
      const before = agentProfile.effective();
      const beforeVersion = agentProfile.currentVersion();
      agentProfile.rollback(version, { source: body?.source || "api", reason: "rollback" });
      const after = agentProfile.effective();
      const afterVersion = agentProfile.currentVersion();
      recordProfileHistory(before, after, body?.source || "rollback", { beforeVersion, afterVersion });
      sendJson(response, 200, agentProfilePayload({ application: profileApplicationSemantics() }));
    } catch (error) { sendJson(response, 404, { error: cleanError(error) }); }
  }

  async function routeProfiles(request, response, url) {
    const pathname = url.pathname;
    if (request.method === "GET" && (pathname === "/v1/agent/settings" || pathname.startsWith("/v1/agent/settings/"))) {
      if (!authorize(request, response)) return true;
      const options = profileOptionsFromUrl(url);
      const query = url.searchParams.get("q") || url.searchParams.get("query") || "";
      const limit = Number(url.searchParams.get("limit") || 20);
      if (pathname === "/v1/agent/settings") {
        const settings = query ? settingsCatalog.search(query, { ...options, limit }) : settingsCatalog.list(options);
        sendJson(response, 200, { version: "profile-settings/v1", query, count: settings.length, settings });
        return true;
      }
      if (pathname === "/v1/agent/settings/recommend") {
        const settings = settingsCatalog.recommend(query, { ...options, limit });
        sendJson(response, 200, { version: "profile-settings/v1", query, count: settings.length, settings });
        return true;
      }
      const id = decodeURIComponent(pathname.slice("/v1/agent/settings/".length));
      const setting = settingsCatalog.get(id, options);
      sendJson(response, setting ? 200 : 404, setting || { error: "unknown_setting", setting_id: id });
      return true;
    }
    if (pathname === "/v1/agent/profile" && request.method === "GET") {
      if (authorize(request, response)) sendJson(response, 200, agentProfilePayload({}, profileOptionsFromUrl(url)));
      return true;
    }
    if (pathname === "/v1/agent/provider-catalog" && request.method === "GET") {
      if (!authorize(request, response)) return true;
      const options = profileOptionsFromUrl(url);
      sendJson(response, 200, providerCatalog({ profile: agentProfile.effective(options) }));
      return true;
    }
    if (pathname === "/v1/agent/profile/history" && request.method === "GET") {
      if (authorize(request, response)) sendJson(response, 200, readProfileHistory({
        limit: Number(url.searchParams.get("limit") || 50),
        systemPromptOnly: url.searchParams.get("system_prompt_only") === "1",
      }));
      return true;
    }
    if (pathname === "/v1/agent/profile/versions" && request.method === "GET") {
      if (!authorize(request, response)) return true;
      const options = profileOptionsFromUrl(url);
      sendJson(response, 200, { current_version: agentProfile.currentVersion(options), scope: options.scope,
        device_id: options.deviceId || "", versions: agentProfile.versions({
          limit: Number(url.searchParams.get("limit") || 50), deviceId: options.deviceId }) });
      return true;
    }
    const handlers = new Map([
      ["PUT:/v1/agent/profile", putProfile],
      ["PUT:/v1/agent/provider-selection", putProviderSelection],
      ["POST:/v1/agent/profile/rollback", rollbackProfile],
      ["POST:/v1/agent/profile/reset", resetProfile],
    ]);
    const handler = handlers.get(`${request.method}:${pathname}`);
    if (!handler) return false;
    if (authorize(request, response)) await handler(request, response);
    return true;
  }

  function sendProviderSelectionError(response, error) {
    if (!error || error.name !== "ProviderSelectionError") return false;
    sendJson(response, Number(error.statusCode) || 409, {
      error: error.code || "provider_selection_unavailable",
      message: cleanError(error),
      ...(error.details || {}),
    });
    return true;
  }

  return { routeProfiles, putProfile, putProviderSelection, resetProfile, rollbackProfile };
}

const PROFILE_ENVELOPE_FIELDS = new Set(["profile", "profile_overrides", "scope", "profile_scope", "device_id", "deviceId", "source", "reason"]);

function unknownProfileFields(body, patch, supportedFields) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return [];
  const wrapped = body && typeof body === "object" && (body.profile === patch || body.profile_overrides === patch);
  const allowed = new Set(supportedFields || []);
  return Object.keys(patch)
    .filter((field) => !allowed.has(field) && (wrapped || !PROFILE_ENVELOPE_FIELDS.has(field)))
    .sort();
}

module.exports = { createProfileHandlers, unknownProfileFields };
