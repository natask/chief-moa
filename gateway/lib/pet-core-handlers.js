"use strict";

function createPetCoreHandlers({
  companionCatalog, agentProfile, catalogVersion, authorizedAgent, agentAuthError,
  readJsonBody, sendJson, cleanError, catalogPayload, activePetPayload,
  profileOptionsFromUrl, profileOptionsFromBody, requireDeviceScope,
  petInputFromBody, manifestV2FieldsFromBody, companionPetRecord,
  petPreviewPayload, companionInputFromPetBody, agentProfileRuntimeStatus,
  summarizePreviewProfile, applyCompanionToProfile, canonicalVoice,
  petGenerationPlan, petGenerationConfigured, callVertexPetImage,
}) {
  function authorize(request, response) {
    if (authorizedAgent(request)) return true;
    sendJson(response, 401, agentAuthError());
    return false;
  }

  async function createPet(request, response) {
    const body = await readJsonBody(request);
    try {
      const companion = companionCatalog.createDraft({
        text: body?.text || body?.request || body?.prompt || body?.description,
        name: body?.name,
        voice: body?.voice,
        pet: petInputFromBody(body),
        image_data_url: body?.image_data_url || body?.imageDataUrl || body?.source_image || body?.sourceImage,
        rules: body?.rules,
        ...manifestV2FieldsFromBody(body),
      });
      const preview = companionCatalog.preview({ companion_id: companion.id });
      sendJson(response, 201, {
        version: catalogVersion,
        pet: companionPetRecord(companion),
        companion,
        preview: petPreviewPayload(preview),
        active_profile_mutated: false,
      });
    } catch (error) { sendJson(response, 400, { error: cleanError(error) }); }
  }

  async function previewPet(request, response) {
    const body = await readJsonBody(request);
    try {
      const preview = companionCatalog.preview(companionInputFromPetBody(body || {}));
      const profileOptions = profileOptionsFromBody(body, "global");
      const base = agentProfile.effective(profileOptions);
      const merged = agentProfile.effectiveWithOverrides(preview.profile_overrides, profileOptions);
      sendJson(response, 200, {
        version: catalogVersion,
        ...petPreviewPayload(preview),
        profile_version: agentProfile.currentVersion(profileOptions),
        profile_before: agentProfileRuntimeStatus(profileOptions),
        profile_preview: summarizePreviewProfile(base, merged),
      });
    } catch (error) { sendJson(response, 404, { error: cleanError(error) }); }
  }

  async function applyPet(request, response) {
    const body = await readJsonBody(request);
    const profileOptions = profileOptionsFromBody(body, "global");
    if (!requireDeviceScope(response, profileOptions)) return;
    try {
      const companionInput = companionInputFromPetBody(body || {});
      const requestedVoice = canonicalVoice(String(body?.voice || "")) || "";
      const result = applyCompanionToProfile(
        companionInput, profileOptions, body?.source || "pet-studio",
        requestedVoice ? { voice: requestedVoice } : {},
      );
      sendJson(response, 200, { version: catalogVersion, pet: companionPetRecord(result.companion), ...result });
    } catch (error) { sendJson(response, 404, { error: cleanError(error) }); }
  }

  async function generatePet(request, response) {
    const body = await readJsonBody(request);
    const plan = petGenerationPlan(body || {});
    if (!petGenerationConfigured()) {
      sendJson(response, 200, {
        version: catalogVersion, status: "not_configured", configured: false, mutates_profile: false,
        message: "Pet image generation is configured on the gateway, but live Vertex calls are disabled or missing credentials.",
        requirement: "Set MOA_PET_ENABLE_VERTEX_GENERATION=1 with Vertex project and Google ADC on the gateway.", plan,
      });
      return;
    }
    try {
      const generated = await callVertexPetImage(plan, body || {});
      sendJson(response, 200, { version: catalogVersion, status: "generated", configured: true, mutates_profile: false, plan, ...generated });
    } catch (error) {
      sendJson(response, 502, { version: catalogVersion, status: "generation_failed", configured: true,
        mutates_profile: false, error: cleanError(error), plan });
    }
  }

  async function routePetCore(request, response, url) {
    if (url.pathname === "/v1/agent/pets" && request.method === "GET") {
      if (authorize(request, response)) sendJson(response, 200, catalogPayload(url));
      return true;
    }
    if (url.pathname === "/v1/agent/pets/active" && request.method === "GET") {
      if (authorize(request, response)) sendJson(response, 200, activePetPayload(profileOptionsFromUrl(url)));
      return true;
    }
    const handlers = new Map([
      ["/v1/agent/pets", createPet], ["/v1/agent/pets/preview", previewPet],
      ["/v1/agent/pets/apply", applyPet], ["/v1/agent/pets/generate", generatePet],
    ]);
    const handler = request.method === "POST" ? handlers.get(url.pathname) : null;
    if (!handler) return false;
    if (authorize(request, response)) await handler(request, response);
    return true;
  }

  return { routePetCore, createPet, previewPet, applyPet, generatePet };
}

module.exports = { createPetCoreHandlers };
