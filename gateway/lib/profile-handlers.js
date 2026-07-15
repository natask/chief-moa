"use strict";

function createProfileHandlers({
  agentProfile, authorizedAgent, agentAuthError, readJsonBody, sendJson, cleanError,
  profileOptionsFromUrl, profileOptionsFromBody, requireDeviceScope,
  agentProfilePayload, readProfileHistory, recordProfileHistory,
  rejectedLanguageFields, supportedLanguagesSentence, profileApplicationSemantics,
}) {
  function authorize(request, response) {
    if (authorizedAgent(request)) return true;
    sendJson(response, 401, agentAuthError());
    return false;
  }

  async function putProfile(request, response) {
    const body = await readJsonBody(request);
    const patch = body && typeof body === "object" ? (body.profile || body.profile_overrides || body) : {};
    const profileOptions = profileOptionsFromBody(body, "global");
    if (!requireDeviceScope(response, profileOptions)) return;
    const before = agentProfile.effective(profileOptions);
    const beforeVersion = agentProfile.currentVersion(profileOptions);
    agentProfile.patch(patch, { source: body?.source || "api", reason: "patch",
      scope: profileOptions.scope, deviceId: profileOptions.deviceId });
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
    if (pathname === "/v1/agent/profile" && request.method === "GET") {
      if (authorize(request, response)) sendJson(response, 200, agentProfilePayload({}, profileOptionsFromUrl(url)));
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
      ["POST:/v1/agent/profile/rollback", rollbackProfile],
      ["POST:/v1/agent/profile/reset", resetProfile],
    ]);
    const handler = handlers.get(`${request.method}:${pathname}`);
    if (!handler) return false;
    if (authorize(request, response)) await handler(request, response);
    return true;
  }

  return { routeProfiles, putProfile, resetProfile, rollbackProfile };
}

module.exports = { createProfileHandlers };
