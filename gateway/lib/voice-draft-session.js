"use strict";

const { createVoiceDraftStore } = require("./voice-drafts");

const CAPABILITY = Object.freeze({
  supported: true,
  revision: "voice_drafts_v1",
  state_machine_revision: "voice_draft_state.v1",
});
const DISABLED_CAPABILITY = Object.freeze({ supported: false, revision: "voice_drafts_v1" });
const CONTROL_ACTIONS = new Set(["pause", "resume", "park", "discard"]);
const BUFFER_BYTES = 256 * 1024;

function createVoiceDraftSessionRuntime(options = {}) {
  const store = options.store || createVoiceDraftStore({ dataDir: options.dataDir });
  return {
    store,
    capability: CAPABILITY,
    status() {
      const status = store.status();
      return {
        ...CAPABILITY,
        store_revision: status.store_revision,
        active_capture: Boolean(status.active_capture_draft_id),
      };
    },
  };
}

class VoiceDraftSessionBridge {
  constructor(connection, runtime) {
    this.connection = connection;
    this.runtime = runtime;
    this.binding = null;
    this.buffers = [];
    this.bufferBytes = 0;
    this.segmentNumber = 0;
  }

  get active() {
    return Boolean(this.binding);
  }

  async start(event, identity) {
    const request = event.voice_draft;
    if (!request) return false;
    if (!this.runtime.store) throw protocolError("voice draft capability is unavailable");
    if (request.version !== CAPABILITY.revision) {
      throw protocolError(`unsupported voice draft version: ${String(request.version || "missing")}`);
    }
    if (this.active || this.connection.turn) throw protocolError("a voice session is already active");
    if (["new", "fork", "incognito"].includes(String(identity.contextAction || "").toLowerCase())) {
      throw protocolError("voice draft branch admission is not available for this context_action");
    }
    const operation = String(request.operation || "create");
    let draft;
    if (operation === "create") {
      draft = this.runtime.store.create({
        idempotency_key: requiredToken(request.idempotency_key, "voice_draft.idempotency_key"),
        session_id: identity.sessionId,
        branch_id: identity.branchId,
        source: event.source,
        surface: request.surface,
        source_session_id: request.source_session_id,
        parent_intent_id: request.parent_intent_id,
        release_id: request.release_id,
        release_version: request.release_version,
        context_action: identity.contextAction,
        capture_lease_id: request.capture_lease_id,
      });
    } else if (operation === "resume") {
      const draftId = requiredToken(request.draft_id, "voice_draft.draft_id");
      const existing = this.runtime.store.get(draftId);
      assertAuthority(existing, identity);
      this.runtime.store.transition(draftId, {
        action: "resume",
        idempotency_key: requiredToken(request.idempotency_key, "voice_draft.idempotency_key"),
        expected_revision: positiveRevision(request.expected_revision),
        actor: actorFor(identity),
      });
      draft = this.runtime.store.get(draftId);
    } else if (operation === "retry_send") {
      const draftId = requiredToken(request.draft_id, "voice_draft.draft_id");
      draft = this.runtime.store.get(draftId);
      assertAuthority(draft, identity);
      if (positiveRevision(request.expected_revision) !== draft.revision
          || draft.state !== "send_ready"
          || draft.claim?.session_id !== identity.sessionId
          || draft.claim?.branch_id !== identity.branchId
          || draft.claim?.turn_id !== identity.turnId) {
        throw protocolError("voice draft retry must match the exact send_ready turn claim");
      }
    } else {
      throw protocolError(`unsupported voice draft operation: ${operation}`);
    }
    assertAuthority(draft, identity);
    this.binding = {
      identity, draftId: draft.id, startEvent: sanitizeStartEvent(event), clientRevision: draft.revision,
    };
    this.segmentNumber = draft.audio.segment_count;
    await this.sendState("session_start", draft, "session_ready");
    return true;
  }

  append(chunk) {
    if (!this.binding) return false;
    const draft = this.current();
    if (draft.state !== "capturing") return true;
    this.buffers.push(Buffer.from(chunk));
    this.bufferBytes += chunk.length;
    while (this.bufferBytes >= BUFFER_BYTES) this.flush(BUFFER_BYTES);
    return true;
  }

  async control(event) {
    if (!this.binding) throw protocolError("no active voice draft");
    const action = String(event.action || "");
    if (!CONTROL_ACTIONS.has(action)) throw protocolError(`unsupported voice draft action: ${action || "missing"}`);
    this.assertEventAuthority(event);
    this.assertClientRevision(event.expected_revision);
    if (action !== "resume") this.flush();
    const current = this.current();
    this.runtime.store.transition(this.binding.draftId, {
      action,
      idempotency_key: requiredToken(event.idempotency_key, "idempotency_key"),
      expected_revision: current.revision,
      actor: actorFor(this.binding.identity),
    });
    const draft = this.current();
    await this.sendState(action, draft);
    if (action === "discard") this.clear();
    return draft;
  }

  async prepareSend(event) {
    if (!this.binding) return null;
    this.assertEventAuthority(event);
    this.assertClientRevision(event.expected_revision);
    this.flush();
    let draft = this.current();
    if (draft.state === "capturing" || draft.state === "paused" || draft.state === "parked") {
      this.runtime.store.transition(draft.id, {
        action: "send_ready",
        idempotency_key: requiredToken(event.idempotency_key, "idempotency_key"),
        expected_revision: draft.revision,
        actor: actorFor(this.binding.identity),
      });
      draft = this.current();
    } else if (draft.state !== "send_ready") {
      throw protocolError(`voice draft cannot send from state ${draft.state}`);
    }
    if (!draft.claim) {
      this.runtime.store.claimForTurn(draft.id, {
        session_id: this.binding.identity.sessionId,
        branch_id: this.binding.identity.branchId,
        turn_id: this.binding.identity.turnId,
        expected_revision: draft.revision,
      });
      draft = this.current();
    }
    const audio = this.runtime.store.readAudio(draft.id).readBuffer();
    const commit = {
      draftId: draft.id,
      expectedSentRevision: draft.revision,
      receiptId: `sent:${draft.id}:${this.binding.identity.turnId}`,
      identity: this.binding.identity,
      startEvent: this.binding.startEvent,
      audio,
    };
    await this.sendState("send", draft);
    return commit;
  }

  async markSent(commit) {
    this.runtime.store.markSent(commit.draftId, {
      receipt_id: commit.receiptId,
      expected_revision: commit.expectedSentRevision,
      session_id: commit.identity.sessionId,
      branch_id: commit.identity.branchId,
      turn_id: commit.identity.turnId,
      actor: actorFor(commit.identity),
    });
    const draft = {
      id: commit.draftId,
      state: "sent",
      revision: commit.expectedSentRevision + 1,
    };
    if (this.binding) await this.sendState("send", draft);
    this.clear();
  }

  async parkOnClose() {
    if (!this.binding) return;
    try {
      this.flush();
      const draft = this.current();
      if (draft.state === "capturing" || draft.state === "paused") {
        this.runtime.store.transition(draft.id, {
          action: "park",
          idempotency_key: `socket-close:${draft.id}:${draft.revision}`,
          expected_revision: draft.revision,
          actor: { kind: "system", id: "voice-session-server" },
        });
      }
    } finally {
      this.clear();
    }
  }

  flush(limit = this.bufferBytes) {
    if (!this.binding || limit <= 0 || this.bufferBytes <= 0) return;
    const combined = Buffer.concat(this.buffers, this.bufferBytes);
    const bytes = combined.subarray(0, Math.min(limit, combined.length));
    const remainder = combined.subarray(bytes.length);
    const draft = this.current();
    this.segmentNumber += 1;
    this.runtime.store.appendSegment(draft.id, {
      segment_id: `ws-${String(this.segmentNumber).padStart(6, "0")}`,
      bytes,
      duration_ms: Math.round(bytes.length / 32),
      expected_revision: draft.revision,
    });
    this.buffers = remainder.length ? [remainder] : [];
    this.bufferBytes = remainder.length;
  }

  current() {
    return this.runtime.store.get(this.binding.draftId);
  }

  assertEventAuthority(event) {
    const { identity, draftId } = this.binding;
    if (event.draft_id !== draftId
        || event.session_id !== identity.sessionId
        || event.branch_id !== identity.branchId
        || event.turn_id !== identity.turnId) {
      throw protocolError("voice draft authority does not match the active session");
    }
  }

  assertClientRevision(value) {
    if (positiveRevision(value) !== this.binding.clientRevision) {
      throw protocolError(
        `voice draft revision conflict: expected ${value}, current ${this.binding.clientRevision}`,
      );
    }
  }

  async sendState(action, draft, type = "voice_draft_state") {
    const { identity } = this.binding;
    this.binding.clientRevision = draft.revision;
    await this.connection.sendEvent({
      type,
      session_id: identity.sessionId,
      branch_id: identity.branchId,
      turn_id: identity.turnId,
      capabilities: { voice_drafts_v1: CAPABILITY },
      voice_draft: {
        draft_id: draft.id,
        revision: draft.revision,
        state: draft.state,
        action,
      },
    });
  }

  clear() {
    this.binding = null;
    this.buffers = [];
    this.bufferBytes = 0;
    this.segmentNumber = 0;
  }
}

function assertAuthority(draft, identity) {
  if (draft.session_id !== identity.sessionId || draft.branch_id !== identity.branchId) {
    throw protocolError("voice draft authority does not match the requested session");
  }
}

function sanitizeStartEvent(event) {
  const clean = { ...event };
  delete clean.voice_draft;
  return clean;
}

function actorFor(identity) {
  return { kind: "client", id: identity.deviceId || "voice-session" };
}

function positiveRevision(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw protocolError("expected_revision must be a positive integer");
  return value;
}

function requiredToken(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw protocolError(`${field} must be a bounded authority token`);
  }
  return value;
}

function protocolError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function disabledVoiceDraftSessionRuntime() {
  return { store: null, capability: DISABLED_CAPABILITY };
}

module.exports = {
  CAPABILITY, VoiceDraftSessionBridge, createVoiceDraftSessionRuntime, disabledVoiceDraftSessionRuntime,
};
