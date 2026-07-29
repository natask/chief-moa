"use strict";

const DEFAULT_COOLDOWN_MS = 2500;
const DEFAULT_MAX_WORDS = 8;
const DEFAULT_MAX_CHARS = 64;
const MAX_RECEIPTS = 32;
const MAX_TRANSCRIPT_CHARS = 12000;

function createVoicePhraseAssistCoordinator(options = {}) {
  const generate = typeof options.generate === "function" ? options.generate : null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const cooldownMs = boundedNonNegative(options.cooldownMs, DEFAULT_COOLDOWN_MS);
  const maxWords = boundedPositive(options.maxWords, DEFAULT_MAX_WORDS);
  const maxChars = boundedPositive(options.maxChars, DEFAULT_MAX_CHARS);
  const states = new WeakMap();

  function stateFor(turn) {
    let state = states.get(turn);
    if (!state) {
      state = {
        revision: 0,
        transcript: "",
        inFlight: null,
        lastStartedAt: Number.NEGATIVE_INFINITY,
        lastStartedTranscript: "",
        receipts: new Map(),
      };
      states.set(turn, state);
    }
    return state;
  }

  async function noteTranscript(turn, text) {
    const state = stateFor(turn);
    const transcript = normalizeTranscript(text);
    if (!transcript || transcript === state.transcript) {
      return state.revision;
    }
    state.transcript = transcript;
    state.revision += 1;
    if (state.inFlight) {
      await finishInFlight(state, state.inFlight, doneEvent(turn, state.inFlight, "stale"));
    }
    return state.revision;
  }

  async function request(turn, input = {}) {
    const state = stateFor(turn);
    const requestId = String(input.requestId || "");
    const emit = typeof input.emit === "function" ? input.emit : async () => {};
    const record = typeof input.record === "function" ? input.record : async () => {};
    const prior = state.receipts.get(requestId);
    if (prior) {
      await emit(prior);
      return prior;
    }
    if (state.inFlight?.requestId === requestId) {
      return null;
    }

    const revision = Number(input.transcriptRevision);
    const rejected = rejectionStatus(turn, state, revision, generate, now(), cooldownMs);
    if (rejected) {
      const event = doneEvent(turn, { requestId, revision }, rejected);
      rememberReceipt(state, requestId, event);
      await emit(event);
      return event;
    }

    const controller = new AbortController();
    const inFlight = {
      requestId,
      revision,
      transcript: state.transcript,
      transcriptChars: state.transcript.length,
      startedAt: now(),
      controller,
      emit,
      record,
      finished: false,
    };
    state.inFlight = inFlight;
    state.lastStartedAt = inFlight.startedAt;
    state.lastStartedTranscript = state.transcript;
    await record("phrase_assist_requested", {
      request_id: requestId,
      transcript_revision: revision,
      transcript_chars: inFlight.transcriptChars,
      pause_ms: boundedNonNegative(input.pauseMs, 0),
    });

    try {
      const raw = await generate({ transcript: inFlight.transcript, signal: controller.signal });
      if (inFlight.finished || state.inFlight !== inFlight || controller.signal.aborted) {
        return null;
      }
      if (turn.status !== "recording" || state.revision !== revision) {
        return finishInFlight(state, inFlight, doneEvent(turn, inFlight, "stale"));
      }
      const phrase = sanitizePhrase(raw, { maxWords, maxChars });
      if (!phrase) {
        return finishInFlight(state, inFlight, doneEvent(turn, inFlight, "empty"));
      }
      return finishInFlight(state, inFlight, {
        type: "phrase_assist_suggestion",
        session_id: turn.sessionId,
        branch_id: turn.branchId,
        turn_id: turn.turnId,
        request_id: requestId,
        transcript_revision: revision,
        phrase,
      });
    } catch (error) {
      if (inFlight.finished || state.inFlight !== inFlight || controller.signal.aborted) {
        return null;
      }
      return finishInFlight(state, inFlight, doneEvent(turn, inFlight, "error"), {
        error_code: phraseAssistErrorCode(error),
      });
    }
  }

  async function cancel(turn, requestId, status = "canceled") {
    const state = stateFor(turn);
    const inFlight = state.inFlight;
    if (!inFlight || (requestId && inFlight.requestId !== requestId)) {
      const prior = requestId ? state.receipts.get(requestId) : null;
      return prior || null;
    }
    return finishInFlight(state, inFlight, doneEvent(turn, inFlight, status));
  }

  async function finishInFlight(state, inFlight, event, extraDiagnostic = {}) {
    if (!inFlight || inFlight.finished) {
      return null;
    }
    inFlight.finished = true;
    inFlight.controller.abort(new Error(`phrase assist ${event.status || "finished"}`));
    if (state.inFlight === inFlight) {
      state.inFlight = null;
    }
    rememberReceipt(state, inFlight.requestId, event);
    await inFlight.record("phrase_assist_terminal", {
      request_id: inFlight.requestId,
      transcript_revision: inFlight.revision,
      status: event.status || "suggested",
      duration_ms: Math.max(0, now() - inFlight.startedAt),
      ...(event.phrase ? { phrase_chars: event.phrase.length } : {}),
      ...extraDiagnostic,
    });
    await inFlight.emit(event);
    return event;
  }

  return {
    available: Boolean(generate),
    noteTranscript,
    request,
    cancel,
    currentRevision(turn) {
      return stateFor(turn).revision;
    },
    currentTranscript(turn) {
      return stateFor(turn).transcript;
    },
  };
}

function createVoicePhraseAssistSessionBridge(connection, options = {}, sanitizeId) {
  const coordinator = createVoicePhraseAssistCoordinator({
    ...(options.phraseAssistOptions || {}),
    generate: options.phraseAssistGenerator,
  });
  return {
    configureTurn(turn, declaration) {
      turn.phraseAssistEnabled = Boolean(
        declaration && typeof declaration === "object"
        && declaration.enabled === true && Number(declaration.version) === 1,
      );
    },
    capability(turn) {
      return { version: 1, enabled: turn.phraseAssistEnabled, available: coordinator.available };
    },
    async revisionField(turn, transcript) {
      const revision = await coordinator.noteTranscript(turn, transcript);
      return turn.phraseAssistEnabled ? { transcript_revision: revision } : {};
    },
    stop: (turn, status = "canceled") => coordinator.cancel(turn, "", status),
    async handleEvent(type, event) {
      if (type !== "phrase_assist_request" && type !== "phrase_assist_cancel") return false;
      const turn = connection.currentTurnFor(event.turn_id);
      if (!turn) return true;
      const requestId = sanitizeId(event.request_id, "request_id");
      if (type === "phrase_assist_cancel") {
        await coordinator.cancel(turn, requestId, "canceled");
        return true;
      }
      await coordinator.request(turn, {
        requestId,
        transcriptRevision: Number(event.transcript_revision),
        pauseMs: event.pause_ms,
        emit: (payload) => connection.sendEvent(payload),
        record: (eventType, payload) => connection.recordProviderEvent(
          turn, turn.providerEvents || connection.createProviderEvents(turn), eventType, payload),
      });
      return true;
    },
  };
}

function rejectionStatus(turn, state, revision, generate, currentTime, cooldownMs) {
  if (turn.phraseAssistEnabled !== true) return "disabled";
  if (!generate) return "unavailable";
  if (turn.status !== "recording") return "inactive";
  if (!Number.isSafeInteger(revision) || revision < 1 || revision !== state.revision) return "stale";
  if (!state.transcript) return "empty";
  if (state.inFlight) return "busy";
  if (state.lastStartedTranscript === state.transcript) return "unchanged";
  if (currentTime - state.lastStartedAt < cooldownMs) return "rate_limited";
  return "";
}

function doneEvent(turn, request, status) {
  return {
    type: "phrase_assist_done",
    session_id: turn.sessionId,
    branch_id: turn.branchId,
    turn_id: turn.turnId,
    request_id: request.requestId,
    transcript_revision: request.revision,
    status,
  };
}

function rememberReceipt(state, requestId, event) {
  if (!requestId) return;
  state.receipts.set(requestId, event);
  while (state.receipts.size > MAX_RECEIPTS) {
    state.receipts.delete(state.receipts.keys().next().value);
  }
}

function normalizeTranscript(value) {
  return String(value || "").trim().replace(/\s+/gu, " ").slice(-MAX_TRANSCRIPT_CHARS);
}

function sanitizePhrase(value, options = {}) {
  const maxWords = boundedPositive(options.maxWords, DEFAULT_MAX_WORDS);
  const maxChars = boundedPositive(options.maxChars, DEFAULT_MAX_CHARS);
  let phrase = normalizeTranscript(value)
    .replace(/^(?:phrase\s*:\s*)/iu, "")
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/gu, "");
  if (!phrase || /^NO_SUGGESTION$/iu.test(phrase)) return "";
  phrase = phrase.split(/\s+/u).slice(0, maxWords).join(" ");
  phrase = Array.from(phrase).slice(0, maxChars).join("").trim();
  return phrase;
}

function phraseAssistErrorCode(error) {
  const name = String(error?.name || "").toLowerCase();
  if (name.includes("abort")) return "aborted";
  if (name.includes("timeout")) return "timeout";
  return "generation_failed";
}

function boundedPositive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function boundedNonNegative(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

module.exports = {
  createVoicePhraseAssistCoordinator,
  createVoicePhraseAssistSessionBridge,
  normalizeTranscript,
  sanitizePhrase,
};
