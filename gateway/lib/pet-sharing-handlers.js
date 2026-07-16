"use strict";

const crypto = require("node:crypto");

function createPetSharingHandlers({
  companionCatalog,
  catalogVersion,
  voiceCloneMaxAudioBytes,
  authorizedAgent,
  agentAuthError,
  readJsonBody,
  sendJson,
  cleanError,
  companionPetRecord,
  profileOptionsFromBody,
  requireDeviceScope,
  applyCompanionToProfile,
  liveVoiceClone = () => String(process.env.MOA_VOICE_CLONE_LIVE || "").trim() === "1",
}) {
  function authorize(request, response) {
    if (authorizedAgent(request)) return true;
    sendJson(response, 401, agentAuthError());
    return false;
  }

  function voiceCloneReferenceFromBody(body = {}) {
    const audioBase64 = typeof body?.reference_audio_base64 === "string" ? body.reference_audio_base64.trim() : "";
    const referenceUrl = typeof body?.reference_url === "string" ? body.reference_url.trim() : "";
    if (audioBase64) {
      const normalized = audioBase64.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(normalized, "base64");
      if (buffer.length === 0) return { ok: false, error: "reference_audio_base64 is not valid base64 audio" };
      if (buffer.length > voiceCloneMaxAudioBytes) {
        return { ok: false, error: `reference audio exceeds the ${voiceCloneMaxAudioBytes}-byte cap` };
      }
      return {
        ok: true,
        record: {
          kind: "audio",
          audio_bytes: buffer.length,
          audio_sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
        },
      };
    }
    if (referenceUrl) {
      let parsed;
      try { parsed = new URL(referenceUrl); }
      catch { return { ok: false, error: "reference_url must be a valid URL" }; }
      if (parsed.protocol !== "https:") return { ok: false, error: "reference_url must be https" };
      return { ok: true, record: { kind: "url", url: parsed.toString() } };
    }
    return { ok: false, error: "provide reference_audio_base64 or reference_url" };
  }

  async function handleVoiceClone(request, response, petId) {
    const body = await readJsonBody(request);
    const pet = companionCatalog.get(petId);
    if (!pet) { sendJson(response, 404, { error: "companion not found" }); return; }
    const consent = body?.consent && typeof body.consent === "object" && !Array.isArray(body.consent) ? body.consent : {};
    if (consent.attested !== true) {
      sendJson(response, 422, { error: "consent.attested must be true to enroll a cloned voice" });
      return;
    }
    const reference = voiceCloneReferenceFromBody(body);
    if (!reference.ok) { sendJson(response, 422, { error: reference.error }); return; }
    try {
      const live = liveVoiceClone();
      const result = companionCatalog.createVoiceCloneJob({
        companion_id: petId,
        consent: { attested: true, subject: String(consent.subject || "") },
        reference: reference.record,
        live,
      });
      sendJson(response, 201, {
        version: catalogVersion,
        job: result.job,
        pet: companionPetRecord(result.companion),
        companion: result.companion,
        blocker: live
          ? "MOA_VOICE_CLONE_LIVE is set but live cloning is not implemented in this change."
          : "Google voice cloning is allowlist-gated for this project; the job is stored in dry-run and the closest canonical voice is bound as the fallback.",
        mutates_profile: false,
      });
    } catch (error) {
      sendJson(response, 400, { error: cleanError(error) });
    }
  }

  function voiceCloneStatusPayload(petId) {
    const pet = companionCatalog.get(petId);
    const jobs = companionCatalog.listVoiceCloneJobs(petId);
    return {
      version: catalogVersion,
      generated_at: new Date().toISOString(),
      companion_id: pet?.id || "",
      found: Boolean(pet),
      voice_binding: pet?.voice_binding || null,
      voice_clone: pet?.voice_clone || null,
      job: jobs.length ? jobs[jobs.length - 1] : null,
      jobs,
    };
  }

  async function handlePublish(request, response, petId) {
    await readJsonBody(request).catch(() => ({}));
    try {
      const companion = companionCatalog.publishCompanion({ id: petId });
      sendJson(response, 200, {
        version: catalogVersion,
        pet: companionPetRecord(companion),
        companion,
        visibility: companion.visibility,
      });
    } catch (error) {
      if (error?.code === "consent_not_approved") {
        sendJson(response, 409, { error: cleanError(error), code: "consent_not_approved", reason: error.reason || "unreviewed" });
      } else if (error?.code === "not_publishable") {
        sendJson(response, 409, { error: cleanError(error), code: "not_publishable" });
      } else {
        sendJson(response, 404, { error: cleanError(error) });
      }
    }
  }

  function sharedPayload(url) {
    const query = url?.searchParams?.get("q") || url?.searchParams?.get("query") || "";
    const limit = Number(url?.searchParams?.get("limit") || 100);
    const shared = companionCatalog.listShared({ query, limit });
    return {
      version: catalogVersion,
      generated_at: new Date().toISOString(),
      query,
      pets: shared.map(companionPetRecord),
      companions: shared,
      endpoints: {
        shared: "/v1/agent/pets/shared",
        install: "/v1/agent/pets/install",
        publish: "/v1/agent/pets/:id/publish",
      },
    };
  }

  async function handleInstall(request, response) {
    const body = await readJsonBody(request);
    const petId = body?.id || body?.companion_id || body?.companionId;
    const companion = companionCatalog.get(petId);
    if (!companion) { sendJson(response, 404, { error: "companion not found" }); return; }
    const profileOptions = profileOptionsFromBody(body, "global");
    if (!requireDeviceScope(response, profileOptions)) return;
    try {
      const result = applyCompanionToProfile({ companion_id: companion.id }, profileOptions, body?.source || "pet-install");
      sendJson(response, 200, {
        version: catalogVersion,
        pet: companionPetRecord(result.companion),
        installed_id: companion.id,
        visibility: companion.visibility,
        ...result,
      });
    } catch (error) {
      sendJson(response, 404, { error: cleanError(error) });
    }
  }

  async function routePetSharing(request, response, url) {
    if (url.pathname === "/v1/agent/pets/shared" && request.method === "GET") {
      if (authorize(request, response)) sendJson(response, 200, sharedPayload(url));
      return true;
    }
    if (url.pathname === "/v1/agent/pets/install" && request.method === "POST") {
      if (authorize(request, response)) await handleInstall(request, response);
      return true;
    }
    const voiceClone = url.pathname.match(/^\/v1\/agent\/pets\/([^/]+)\/voice-clone$/);
    if (voiceClone) {
      if (!authorize(request, response)) return true;
      const petId = decodeURIComponent(voiceClone[1]);
      if (request.method === "POST") {
        await handleVoiceClone(request, response, petId);
        return true;
      }
      if (request.method === "GET") {
        sendJson(response, 200, voiceCloneStatusPayload(petId));
        return true;
      }
      return false;
    }
    const publish = url.pathname.match(/^\/v1\/agent\/pets\/([^/]+)\/publish$/);
    if (publish && request.method === "POST") {
      if (authorize(request, response)) await handlePublish(request, response, decodeURIComponent(publish[1]));
      return true;
    }
    return false;
  }

  return { routePetSharing, sharedPayload, voiceCloneReferenceFromBody };
}

module.exports = { createPetSharingHandlers };
