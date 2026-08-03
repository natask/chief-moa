(() => {
  const VERSION = "voice_drafts_v1";
  const STATE_REVISION = "voice_draft_state.v1";
  const TOKEN = /^[A-Za-z0-9._:-]{1,120}$/;
  const CONTROL_STATES = Object.freeze({ pause: "paused", resume: "capturing", park: "parked", discard: "discarded" });

  const authorityToken = (value) => typeof value === "string" && TOKEN.test(value) ? value : "";
  const positiveRevision = (value) => Number.isSafeInteger(value) && value > 0 ? value : 0;

  function normalizeCapability(value) {
    if (!value || typeof value !== "object") return null;
    if (value.supported !== true || value.revision !== VERSION || value.state_machine_revision !== STATE_REVISION) return null;
    return { supported: true, revision: VERSION, stateMachineRevision: STATE_REVISION };
  }

  function capabilityFromHealth(health) {
    return normalizeCapability(health?.voice_stream?.provider?.voice_drafts_v1);
  }

  function capabilityFresh(value, now = Date.now()) {
    return value?.supported === true && value.stale !== true && Number.isSafeInteger(value.expiresAtMs) && value.expiresAtMs > now;
  }

  function acceptedCapabilityResponse(requestGeneration, currentGeneration, response) {
    if (!Number.isSafeInteger(requestGeneration) || requestGeneration !== currentGeneration || !response || typeof response !== "object") return null;
    const gatewayUrl = typeof response.gateway_url === "string" && response.gateway_url === response.gateway_url.trim()
      ? response.gateway_url : "";
    return {
      supported: response.supported === true && Boolean(gatewayUrl),
      stale: response.stale === true,
      expiresAtMs: Number.isSafeInteger(response.expires_at_ms) ? response.expires_at_ms : 0,
      gatewayUrl,
    };
  }

  function authority(value = {}) {
    const sessionId = authorityToken(value.sessionId ?? value.session_id);
    const branchId = authorityToken(value.branchId ?? value.branch_id);
    const turnId = authorityToken(value.turnId ?? value.turn_id);
    return sessionId && branchId && turnId ? { sessionId, branchId, turnId } : null;
  }

  function normalizeStoredPointer(value) {
    if (!value || typeof value !== "object") return null;
    const draftId = authorityToken(value.draftId ?? value.draft_id);
    const revision = positiveRevision(value.revision ?? value.draft_revision);
    const bound = authority(value);
    return draftId && revision && bound ? { draftId, revision, ...bound, state: String(value.state || "") } : null;
  }

  function pointerFromEvent(message) {
    const bound = authority(message);
    const draft = message?.voice_draft;
    const draftId = authorityToken(draft?.draft_id);
    const revision = positiveRevision(draft?.revision);
    const state = typeof draft?.state === "string" ? draft.state : "";
    const action = typeof draft?.action === "string" ? draft.action : "";
    return bound && draftId && revision && state && action
      ? { draftId, revision, state, action, ...bound }
      : null;
  }

  function sameAuthority(left, right, { includeDraft = true } = {}) {
    const a = authority(left);
    const b = authority(right);
    if (!a || !b || a.sessionId !== b.sessionId || a.branchId !== b.branchId || a.turnId !== b.turnId) return false;
    return !includeDraft || authorityToken(left?.draftId ?? left?.draft_id) === authorityToken(right?.draftId ?? right?.draft_id);
  }

  function validateReady(message, expected = {}) {
    if (message?.type !== "session_ready" || !normalizeCapability(message?.capabilities?.voice_drafts_v1)) return null;
    const pointer = pointerFromEvent(message);
    const expectedAuthority = authority(expected);
    if (!pointer || !expectedAuthority || !sameAuthority(pointer, expectedAuthority, { includeDraft: false })) return null;
    if (pointer.action !== "session_start" || pointer.state !== "capturing") return null;
    const operation = expected.operation === "resume" ? "resume" : "create";
    if (operation === "resume") {
      const prior = normalizeStoredPointer(expected.pointer);
      if (!prior || !sameAuthority(pointer, prior) || pointer.draftId !== prior.draftId || pointer.revision <= prior.revision) return null;
    } else if (expected.pointer) return null;
    return pointer;
  }

  function validateCommittedTurnReady(message, pointerValue) {
    if (message?.type !== "session_ready" || !normalizeCapability(message?.capabilities?.voice_drafts_v1)) return false;
    if (message.voice_draft !== undefined) return false;
    const pointer = normalizeStoredPointer(pointerValue);
    if (!pointer || pointer.state !== "send_ready") return false;
    return sameAuthority(message, pointer, { includeDraft: false });
  }

  function validateState(message, expected = {}) {
    if (message?.type !== "voice_draft_state" || !normalizeCapability(message?.capabilities?.voice_drafts_v1)) return null;
    const prior = normalizeStoredPointer(expected.pointer);
    const pointer = pointerFromEvent(message);
    if (!prior || !pointer || !sameAuthority(pointer, prior) || pointer.draftId !== prior.draftId || pointer.revision <= prior.revision) return null;
    const pending = String(expected.action || "");
    if (pending === "send") {
      if (pointer.action !== "send" || !["send_ready", "sent"].includes(pointer.state)) return null;
    } else if (CONTROL_STATES[pending] !== pointer.state || pointer.action !== pending) return null;
    return pointer;
  }

  function idempotencyKey(action, pointer) {
    return `browser:${pointer.turnId}:${action}:${pointer.revision}`;
  }

  function startDescriptor(input = {}) {
    const bound = authority(input);
    if (!bound) return null;
    const operation = input.operation === "resume" ? "resume" : "create";
    const pointer = input.pointer ? normalizeStoredPointer(input.pointer) : null;
    if ((operation === "resume") !== Boolean(pointer)) return null;
    if (pointer && !sameAuthority(pointer, bound, { includeDraft: false })) return null;
    return {
      version: VERSION,
      operation,
      idempotency_key: operation === "resume" ? idempotencyKey("resume-start", pointer) : `browser:${bound.turnId}:create:1`,
      surface: "browser",
      ...(pointer ? { draft_id: pointer.draftId, expected_revision: pointer.revision } : {}),
    };
  }

  function controlRequest(action, pointerValue) {
    const pointer = normalizeStoredPointer(pointerValue);
    if (!pointer || !Object.hasOwn(CONTROL_STATES, action)) return null;
    return {
      type: "voice_draft_control",
      session_id: pointer.sessionId,
      branch_id: pointer.branchId,
      turn_id: pointer.turnId,
      draft_id: pointer.draftId,
      expected_revision: pointer.revision,
      action,
      idempotency_key: idempotencyKey(action, pointer),
    };
  }

  function commitRequest(pointerValue) {
    const pointer = normalizeStoredPointer(pointerValue);
    if (!pointer) return null;
    return {
      type: "commit_turn",
      session_id: pointer.sessionId,
      branch_id: pointer.branchId,
      turn_id: pointer.turnId,
      draft_id: pointer.draftId,
      expected_revision: pointer.revision,
      idempotency_key: idempotencyKey("send", pointer),
    };
  }

  function validateClientRequest(message, pointerValue) {
    const pointer = normalizeStoredPointer(pointerValue);
    if (!pointer || !message || typeof message !== "object") return false;
    const expected = message.type === "commit_turn"
      ? commitRequest(pointer)
      : controlRequest(message.action, pointer);
    if (!expected) return false;
    return Object.keys(expected).every((key) => message[key] === expected[key]);
  }

  globalThis.AgeeVoiceDraftProtocol = Object.freeze({
    VERSION,
    STATE_REVISION,
    acceptedCapabilityResponse,
    authority,
    authorityToken,
    capabilityFresh,
    capabilityFromHealth,
    commitRequest,
    controlRequest,
    normalizeCapability,
    normalizeStoredPointer,
    pointerFromEvent,
    positiveRevision,
    sameAuthority,
    startDescriptor,
    validateClientRequest,
    validateCommittedTurnReady,
    validateReady,
    validateState,
  });
})();
