"use strict";

function createCompanionHandlers({
  companionCatalog, agentProfile, companionRuntimeAuthority,
  authorizedAgent, agentAuthError, readJsonBody, sendJson, cleanError,
  activeCompanionPayload, profileOptionsFromBody, requireDeviceScope,
  agentProfileRuntimeStatus, summarizePreviewProfile, applyCompanionToProfile,
}) {
  function authorize(request, response) {
    if (authorizedAgent(request)) return true;
    sendJson(response, 401, agentAuthError());
    return false;
  }

  function catalogPayload(url) {
    const query = url?.searchParams?.get("q") || url?.searchParams?.get("query") || "";
    const limit = Number(url?.searchParams?.get("limit") || 100);
    const profile = agentProfile.effective();
    return {
      version: companionCatalog.version,
      generated_at: new Date().toISOString(),
      query,
      active_companion_id: profile.active_companion_id || "",
      active_companion: activeCompanionPayload(profile),
      companions: companionCatalog.list({ query, limit }),
      endpoints: {
        list: "/v1/agent/companions", create: "/v1/agent/companions",
        preview: "/v1/agent/companions/preview", apply: "/v1/agent/companions/apply",
      },
    };
  }

  async function createCompanion(request, response) {
    const body = await readJsonBody(request);
    try {
      const companion = companionCatalog.createDraft({
        text: body?.text || body?.request || body?.prompt || body?.description,
        name: body?.name, voice: body?.voice, rules: body?.rules,
      });
      const preview = companionCatalog.preview({ companion_id: companion.id });
      sendJson(response, 201, { companion, preview, active_profile_mutated: false });
    } catch (error) { sendJson(response, 400, { error: cleanError(error) }); }
  }

  async function previewCompanion(request, response) {
    const body = await readJsonBody(request);
    const profileOptions = profileOptionsFromBody(body, "global");
    if (body?.package_base64 || body?.package || body?.approval_binding) {
      try {
        const current = String(agentProfile.currentVersion(profileOptions));
        const expected = String(body?.expected_profile_version || "") || current;
        if (expected !== current) throw new Error("expected_profile_version is stale");
        sendJson(response, 200, companionRuntimeAuthority.preview({ ...body, scope: profileOptions.scope,
          device_id: profileOptions.deviceId, expected_profile_version: expected }));
      } catch (error) {
        sendJson(response, 400, { error: cleanError(error), code: error?.code || "companion_authority_rejected" });
      }
      return;
    }
    try {
      const preview = companionCatalog.preview(body || {});
      const base = agentProfile.effective(profileOptions);
      const merged = agentProfile.effectiveWithOverrides(preview.profile_overrides, profileOptions);
      sendJson(response, 200, { ...preview, mutates_profile: false,
        profile_version: agentProfile.currentVersion(profileOptions),
        profile_before: agentProfileRuntimeStatus(profileOptions),
        profile_preview: summarizePreviewProfile(base, merged) });
    } catch (error) { sendJson(response, 404, { error: cleanError(error) }); }
  }

  async function applyCompanion(request, response) {
    const body = await readJsonBody(request);
    const profileOptions = profileOptionsFromBody(body, "global");
    if (!requireDeviceScope(response, profileOptions)) return;
    if (body?.package_base64 || body?.package || body?.approval_binding || body?.package_digest) {
      try {
        sendJson(response, 200, companionRuntimeAuthority.apply({ ...body, scope: profileOptions.scope,
          device_id: profileOptions.deviceId }));
      } catch (error) {
        sendJson(response, 409, { error: cleanError(error), code: error?.code || "companion_authority_rejected" });
      }
      return;
    }
    try { sendJson(response, 200, applyCompanionToProfile(body || {}, profileOptions, body?.source || "api")); }
    catch (error) { sendJson(response, 404, { error: cleanError(error) }); }
  }

  async function rollbackCompanion(request, response) {
    const body = await readJsonBody(request);
    try { sendJson(response, 200, companionRuntimeAuthority.rollback(body || {})); }
    catch (error) { sendJson(response, 409, { error: cleanError(error), code: error?.code || "companion_authority_rejected" }); }
  }

  async function routeCompanions(request, response, url) {
    if (url.pathname === "/v1/agent/companions" && request.method === "GET") {
      if (authorize(request, response)) sendJson(response, 200, catalogPayload(url));
      return true;
    }
    const handlers = new Map([
      ["/v1/agent/companions", createCompanion],
      ["/v1/agent/companions/preview", previewCompanion],
      ["/v1/agent/companions/apply", applyCompanion],
      ["/v1/agent/companions/rollback", rollbackCompanion],
    ]);
    const handler = request.method === "POST" ? handlers.get(url.pathname) : null;
    if (!handler) return false;
    if (authorize(request, response)) await handler(request, response);
    return true;
  }

  return { routeCompanions, catalogPayload };
}

module.exports = { createCompanionHandlers };
