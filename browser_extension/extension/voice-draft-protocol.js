(() => {
  const CONTEXT_ACTIONS = new Set(["continue", "new", "fork", "incognito"]);
  const CONTROL_ACTIONS = new Set(["pause", "park", "discard"]);
  const CONTROL_STATES = Object.freeze({ pause: "paused", park: "parked", discard: "discarded" });
  const TERMINAL_STATES = new Set(["sent", "discarded"]);
  const AUTHORITY_TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/;
  const MAX_AUTHORITY_TOKEN_LENGTH = 120;

  function positiveRevision(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  function authorityToken(value) {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_AUTHORITY_TOKEN_LENGTH &&
      AUTHORITY_TOKEN_PATTERN.test(value)
    ) ? value : "";
  }

  function exactAliasedValue(value, names, validator) {
    let canonical;
    let found = false;
    for (const name of names) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
      const candidate = validator(value[name]);
      if (!candidate) return null;
      if (found && candidate !== canonical) return null;
      canonical = candidate;
      found = true;
    }
    return found ? canonical : null;
  }

  function normalizeStoredPointer(value) {
    if (!value || typeof value !== "object") return null;
    const draftId = exactAliasedValue(value, ["draftId", "id", "draft_id", "voice_draft_id"], authorityToken);
    const revision = exactAliasedValue(value, ["revision", "draft_revision", "voice_draft_revision"], positiveRevision);
    const sessionId = exactAliasedValue(value, ["sessionId", "session_id"], authorityToken);
    const branchId = exactAliasedValue(value, ["branchId", "branch_id"], authorityToken);
    if (!draftId || !revision || !sessionId || !branchId) return null;
    return { draftId, revision, sessionId, branchId };
  }

  function normalizeCanonicalDraft(value) {
    if (!value || typeof value !== "object") return null;
    const draftId = authorityToken(value.id);
    const revision = positiveRevision(value.revision);
    const sessionId = authorityToken(value.session_id);
    const branchId = authorityToken(value.branch_id);
    const state = typeof value.state === "string" ? value.state : "";
    if (!draftId || !revision || !sessionId || !branchId || !state) return null;
    return { draftId, revision, sessionId, branchId, state };
  }

  function normalizeContextAction(value) {
    const action = value === undefined || value === null || value === "" ? "continue" : value;
    return CONTEXT_ACTIONS.has(action) ? action : "";
  }

  function exactTopLevelAuthority(message, expected) {
    const sessionId = authorityToken(message?.session_id);
    const branchId = authorityToken(message?.branch_id);
    const turnId = authorityToken(message?.turn_id);
    const expectedSessionId = authorityToken(expected?.sessionId);
    const expectedBranchId = authorityToken(expected?.branchId);
    const expectedTurnId = authorityToken(expected?.turnId);
    if (!sessionId || !expectedSessionId || sessionId !== expectedSessionId) {
      return { ok: false, error: "Gateway returned mismatched top-level voice-draft session authority." };
    }
    if (!branchId || !expectedBranchId || branchId !== expectedBranchId) {
      return { ok: false, error: "Gateway returned mismatched top-level voice-draft branch authority." };
    }
    if (!turnId || !expectedTurnId || turnId !== expectedTurnId) {
      return { ok: false, error: "Gateway returned mismatched top-level voice-draft turn authority." };
    }
    return { ok: true, sessionId, branchId, turnId };
  }

  function validateReady(message, expected = {}) {
    if (!message || typeof message !== "object" || message.type !== "voice_draft_ready") {
      return { ok: false, error: "Gateway did not send the canonical voice_draft_ready event." };
    }
    const action = typeof message.action === "string" ? message.action : "";
    if (!['create', 'resume'].includes(action) || action !== expected.action) {
      return { ok: false, error: "Gateway returned the wrong voice-draft ready action." };
    }
    const top = exactTopLevelAuthority(message, expected);
    if (!top.ok) return top;
    const pointer = normalizeCanonicalDraft(message.draft);
    if (!pointer) {
      return { ok: false, error: "Gateway did not bind canonical voice-draft ID, integer revision, state, session, and branch authority." };
    }
    if (pointer.state !== "capturing") {
      return { ok: false, error: "Gateway did not return a capturing voice draft." };
    }
    if (pointer.sessionId !== top.sessionId || pointer.branchId !== top.branchId) {
      return { ok: false, error: "Gateway returned inconsistent nested voice-draft authority." };
    }
    const expectedDraftSupplied = expected.draftId !== "" && expected.draftId !== undefined && expected.draftId !== null;
    const expectedDraftId = expectedDraftSupplied ? authorityToken(expected.draftId) : "";
    if (expectedDraftSupplied && !expectedDraftId) {
      return { ok: false, error: "Local voice-draft authority is malformed." };
    }
    const requestedRevision = positiveRevision(expected.requestedRevision);
    if (action === "resume") {
      if (!expectedDraftId || pointer.draftId !== expectedDraftId) {
        return { ok: false, error: "Gateway returned a different voice draft while resuming." };
      }
      if (!requestedRevision || pointer.revision <= requestedRevision) {
        return { ok: false, error: "Gateway did not advance the resumed voice-draft revision." };
      }
    } else if (expectedDraftId || requestedRevision || ![0, undefined, null].includes(expected.requestedRevision)) {
      return { ok: false, error: "A create-ready event cannot replace requested draft authority." };
    }
    return { ok: true, action, pointer, ...top };
  }

  function validateControlAck(message, expected = {}) {
    if (!message || typeof message !== "object" || message.type !== "voice_draft_control_ack") return null;
    const action = typeof message.action === "string" ? message.action : "";
    const expectedAction = typeof expected.action === "string" ? expected.action : "";
    const expectedDraftId = authorityToken(expected.draftId);
    const expectedState = typeof expected.state === "string" ? expected.state : "";
    const baseRevision = positiveRevision(expected.baseRevision);
    if (
      !CONTROL_ACTIONS.has(action) ||
      action !== expectedAction ||
      expectedState !== CONTROL_STATES[action] ||
      !expectedDraftId ||
      !baseRevision
    ) return null;
    const top = exactTopLevelAuthority(message, expected);
    if (!top.ok) return null;
    const pointer = normalizeCanonicalDraft(message.draft);
    if (!pointer) return null;
    if (
      pointer.draftId !== expectedDraftId ||
      pointer.sessionId !== top.sessionId ||
      pointer.branchId !== top.branchId ||
      pointer.revision <= baseRevision ||
      pointer.state !== expectedState
    ) return null;
    return pointer;
  }

  function validateTerminalReceipt(message, expected = {}) {
    if (!message || typeof message !== "object" || message.type !== "turn_done") return null;
    const expectedDraftId = authorityToken(expected.draftId);
    const baseRevision = positiveRevision(expected.baseRevision);
    if (!expectedDraftId || !baseRevision) return null;
    const top = exactTopLevelAuthority(message, expected);
    if (!top.ok) return null;
    const pointer = normalizeCanonicalDraft(message.draft);
    if (!pointer || !TERMINAL_STATES.has(pointer.state)) return null;
    if (
      pointer.draftId !== expectedDraftId ||
      pointer.sessionId !== top.sessionId ||
      pointer.branchId !== top.branchId ||
      pointer.revision <= baseRevision
    ) return null;
    return pointer;
  }

  function capabilityFresh(capability, now = Date.now()) {
    const expiresAtMs = capability?.expiresAtMs;
    return (
      capability?.supported === true &&
      capability?.stale !== true &&
      Number.isSafeInteger(expiresAtMs) &&
      expiresAtMs > now
    );
  }

  function validateResumePointer(input = {}) {
    const identifiersAbsent = [input.draftId, input.sessionId, input.branchId]
      .every((value) => value === undefined || value === null || value === "");
    const revisionAbsent = input.revision === undefined || input.revision === null || input.revision === 0;
    if (identifiersAbsent && revisionAbsent) return { ok: true, pointer: null };
    const pointer = normalizeStoredPointer({
      draftId: input.draftId,
      revision: input.revision,
      sessionId: input.sessionId,
      branchId: input.branchId,
    });
    return pointer
      ? { ok: true, pointer }
      : { ok: false, pointer: null, error: "Voice-draft resume authority is malformed or incomplete." };
  }

  function validateStartAuthority(response, expected = {}) {
    if (!response || typeof response !== "object") return null;
    const sessionId = authorityToken(response.session_id);
    const branchId = authorityToken(response.branch_id);
    const turnId = authorityToken(response.turn_id);
    const expectedSessionId = authorityToken(expected.sessionId);
    const expectedBranchId = authorityToken(expected.branchId);
    const expectedTurnId = authorityToken(expected.turnId);
    if (
      !sessionId || !branchId || !turnId ||
      !expectedSessionId || !expectedBranchId || !expectedTurnId ||
      sessionId !== expectedSessionId ||
      branchId !== expectedBranchId ||
      turnId !== expectedTurnId
    ) return null;
    return { sessionId, branchId, turnId };
  }

  function commitControlRequest(input = {}) {
    const turnId = authorityToken(input.turnId);
    if (!turnId) return null;
    const voiceSessionId = input.voiceSessionId == null || input.voiceSessionId === ""
      ? null
      : authorityToken(input.voiceSessionId);
    if (input.voiceSessionId != null && input.voiceSessionId !== "" && !voiceSessionId) return null;
    return {
      cmd: "voiceSessionControl",
      voiceSessionId,
      turnId,
      message: { type: "commit_turn", turn_id: turnId },
    };
  }

  function lateStartDisposition(input = {}) {
    if (input.active === true) return null;
    const voiceSessionId = authorityToken(input.voiceSessionId);
    const turnId = authorityToken(input.turnId);
    if (!voiceSessionId || !turnId) return null;
    if (input.draftMode === true) {
      return {
        primary: {
          cmd: "voiceSessionControl",
          voiceSessionId,
          turnId,
          message: { type: "discard_turn", turn_id: turnId },
        },
        fallback: {
          cmd: "voiceSessionClose",
          voiceSessionId,
          reason: "voice start was cancelled before attachment",
        },
      };
    }
    return {
      primary: {
        cmd: "voiceSessionClose",
        voiceSessionId,
        reason: "voice start was cancelled before attachment",
      },
      fallback: null,
    };
  }

  function acceptedCapabilityResponse(requestGeneration, currentGeneration, response) {
    if (!Number.isSafeInteger(requestGeneration) || requestGeneration !== currentGeneration) return null;
    if (!response || typeof response !== "object") return null;
    const gatewayUrl = typeof response.gateway_url === "string"
      && response.gateway_url.length > 0
      && response.gateway_url === response.gateway_url.trim()
      ? response.gateway_url
      : "";
    return {
      supported: response.supported === true && Boolean(gatewayUrl),
      stale: response.stale === true,
      expiresAtMs: Number.isSafeInteger(response.expires_at_ms) ? response.expires_at_ms : 0,
      gatewayUrl,
    };
  }

  globalThis.AgeeVoiceDraftProtocol = Object.freeze({
    authorityToken,
    acceptedCapabilityResponse,
    capabilityFresh,
    commitControlRequest,
    lateStartDisposition,
    normalizeCanonicalDraft,
    normalizeContextAction,
    normalizeStoredPointer,
    positiveRevision,
    validateResumePointer,
    validateStartAuthority,
    validateControlAck,
    validateReady,
    validateTerminalReceipt,
  });
})();
