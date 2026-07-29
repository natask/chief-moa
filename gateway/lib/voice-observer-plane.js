"use strict";

// The live voice observer plane.
//
// A registration point where a plug-in receives read-only frames of the
// in-progress turn and either proposes an utterance or declines. Declining is
// meant to be free: the plane pre-filters every frame against the observer's
// declared triggers, stability minimum, language set, interval, and budget
// BEFORE calling it, so on a normal turn most frames never reach observer code.
//
// Nothing here can block a voice turn. `note()` is synchronous and returns
// void; dispatch runs on a detached promise under a latency budget with an
// abort signal. If this whole module were deleted mid-turn the turn would
// complete identically.
//
// Delivery is not decided here. Observers propose; voice-delivery-arbiter.js
// decides. See reference/openspec/changes/live-voice-observer-plane/design.md.

const crypto = require("node:crypto");
const { inspectTranscriptScript } = require("./transcript-quality");
const {
  DEFAULT_ARBITRATION_WINDOW_MS, DEFAULT_MAX_REVISION_DRIFT,
  decide, deliveryReceipt, normalizeObserverPolicy,
} = require("./voice-delivery-arbiter");

const OBSERVATION_VERSION = "moa.voice-observation.v1";
const PROPOSAL_VERSION = "moa.voice-proposal.v1";
const TRIGGERS = Object.freeze(["partial", "final", "pause", "vad_stop", "floor_change", "tick"]);
const DEFAULT_MAX_LATENCY_MS = 250;
const MAX_LATENCY_CEILING_MS = 2000;
const DEFAULT_MIN_INTERVAL_MS = 1200;
const DEFAULT_MAX_PROPOSALS_PER_TURN = 3;
// Consecutive timeouts or throws before an observer is taken out of the
// session. Three is enough to distinguish a slow provider from a broken one.
const MAX_STRIKES = 3;
const MAX_TRANSCRIPT_CHARS = 12000;
// A prefix counts as settled only once this many consecutive hypotheses agree
// on it. A rotation folds the last interim into finalized text
// (voice-stt-streaming.js), so freshly finalized text can still be revised.
const STABLE_EMISSIONS = 2;

function digestOf(text) {
  if (!text) return "";
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32)}`;
}

function registerSpec(spec) {
  const id = String(spec?.id || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
    throw new Error("a voice observer requires a lowercase kebab-case id of at most 40 characters");
  }
  if (typeof spec?.observe !== "function") {
    throw new Error(`voice observer ${id} requires an observe() function`);
  }
  if (Number(spec?.version) !== 1) {
    throw new Error(`voice observer ${id} declares an unsupported contract version`);
  }
  const triggers = Array.isArray(spec.triggers) ? spec.triggers.map((value) => String(value)) : [];
  const unknown = triggers.filter((value) => !TRIGGERS.includes(value));
  if (!triggers.length || unknown.length) {
    throw new Error(`voice observer ${id} declares unknown triggers: ${unknown.join(", ") || "(none declared)"}`);
  }
  return Object.freeze({
    id,
    version: 1,
    priority: Number.isFinite(Number(spec.priority)) ? Math.trunc(Number(spec.priority)) : 0,
    triggers: Object.freeze(triggers),
    minStability: clamp01(spec.minStability),
    minIntervalMs: bounded(spec.minIntervalMs, DEFAULT_MIN_INTERVAL_MS),
    maxProposalsPerTurn: bounded(spec.maxProposalsPerTurn, DEFAULT_MAX_PROPOSALS_PER_TURN),
    maxLatencyMs: Math.min(MAX_LATENCY_CEILING_MS, bounded(spec.maxLatencyMs, DEFAULT_MAX_LATENCY_MS)),
    languages: Object.freeze(
      Array.isArray(spec.languages) && spec.languages.length
        ? spec.languages.map((value) => String(value).toLowerCase())
        : ["*"],
    ),
    // False unless the observer's output is independent of the user's exact
    // wording. Anything that quotes, corrects, or asserts what was said is not
    // partial-safe and can only ever be a bubble mid-utterance.
    partialSafe: spec.partialSafe === true,
    quotesUser: spec.quotesUser === true,
    maxDelivery: String(spec.maxDelivery || "defer"),
    allowDeferFallback: spec.allowDeferFallback !== false,
    observe: spec.observe,
  });
}

function createVoiceObserverPlane(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const observers = new Map();
  const quarantined = new Set();
  const states = new WeakMap();
  const arbitrationWindowMs = bounded(options.arbitrationWindowMs, DEFAULT_ARBITRATION_WINDOW_MS);
  const maxRevisionDrift = bounded(options.maxRevisionDrift, DEFAULT_MAX_REVISION_DRIFT);
  const schedule = typeof options.schedule === "function"
    ? options.schedule
    : (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; };

  function stateFor(turn) {
    let state = states.get(turn);
    if (!state) {
      state = {
        revision: 0,
        sequence: 0,
        stableText: "",
        stableRevision: 0,
        tailText: "",
        priorPartial: "",
        stableChain: new Set(),
        retiredDigests: new Set(),
        observers: new Map(),
        pendingProposals: [],
        windowTimer: null,
        delivered: new Map(),
      };
      states.set(turn, state);
    }
    return state;
  }

  function observerState(state, id) {
    let entry = state.observers.get(id);
    if (!entry) {
      entry = { lastInvokedAt: Number.NEGATIVE_INFINITY, lastStableRevision: -1, proposals: 0, strikes: 0, inFlight: null, pendingFrame: null };
      state.observers.set(id, entry);
    }
    return entry;
  }

  // Derive the settled prefix from successive partials. The authoritative
  // source is the finalized/interim split inside createStreamingSttSession;
  // until that is plumbed through the session hooks, the longest common prefix
  // of the two most recent emissions is the same signal observed one layer out:
  // it is exactly the text two consecutive hypotheses agree on, which is what
  // STABLE_EMISSIONS asks for. A single emission agrees with nothing, so the
  // first partial of a turn has a watermark of zero.
  function advanceTranscript(state, text) {
    const value = normalizeTranscript(text);
    if (!value) return false;
    if (value === state.priorPartial) return false;
    state.revision += 1;
    const agreed = longestCommonPrefix(state.priorPartial, value).trim();
    state.priorPartial = value;
    if (agreed !== state.stableText) {
      // Growing is fine — the user said more. Diverging is not: the recognizer
      // rewrote settled words, so every proposal built on the old prefix is
      // wrong rather than merely stale.
      if (state.stableText && !agreed.startsWith(state.stableText)) {
        for (const digest of state.stableChain) state.retiredDigests.add(digest);
        state.stableChain.clear();
      }
      state.stableText = agreed;
      state.stableRevision = state.revision;
    }
    state.tailText = value.slice(state.stableText.length).trim();
    if (state.stableText) state.stableChain.add(digestOf(state.stableText));
    return true;
  }

  function buildFrame(turn, state, input) {
    const stable = state.stableText;
    const tail = stable ? state.tailText : state.priorPartial;
    const stableChars = Array.from(stable).length;
    const tailChars = Array.from(tail).length;
    const total = stableChars + tailChars;
    state.sequence += 1;
    return Object.freeze({
      version: OBSERVATION_VERSION,
      session_id: turn.sessionId,
      branch_id: turn.branchId,
      turn_id: turn.turnId,
      trigger: String(input.trigger || "partial"),
      sequence: state.sequence,
      transcript: Object.freeze({
        revision: state.revision,
        stable_text: stable,
        stable_revision: state.stableRevision,
        tail_text: tail,
        chars: total,
        words: stable ? stable.split(/\s+/u).length : 0,
      }),
      stability: Object.freeze({
        watermark: total ? round4(stableChars / total) : 0,
        stable_ratio: total ? round4(stableChars / total) : 0,
        revisions_since_stable_change: Math.max(0, state.revision - state.stableRevision),
        last_change_ms: bounded(input.lastChangeMs, 0),
      }),
      vad: Object.freeze({
        state: String(input.vadState || "speaking"),
        pause_ms: bounded(input.pauseMs, 0),
        speech_ms: bounded(input.speechMs, 0),
      }),
      timing: Object.freeze({
        turn_elapsed_ms: bounded(input.turnElapsedMs, 0),
        since_last_frame_ms: bounded(input.sinceLastFrameMs, 0),
      }),
      language: Object.freeze({
        input_codes: Object.freeze(languageCodes(input.languages)),
        reply_code: String(input.replyLanguage || ""),
        scripts: Object.freeze(scriptsFor(input.languages)),
      }),
      floor: Object.freeze({
        holder: String(input.floorHolder || "user"),
        assistant_speaking: input.assistantSpeaking === true,
        reply_in_flight: input.replyInFlight === true,
        ms_since_reply_end: Number(input.msSinceReplyEnd ?? Infinity),
      }),
      prior_turn: input.priorTurn || null,
      budget: Object.freeze({ latency_ms: 0, proposals_remaining: 0 }),
    });
  }

  // The seven-step pre-filter. Everything an observer would have had to
  // re-implement, done once, before its code runs.
  function admits(observer, entry, frame, policy, currentTime, qualityAccepted) {
    if (!policy.enabled) return "policy_disabled";
    if (quarantined.has(observer.id)) return "quarantined";
    if (entry.proposals >= observer.maxProposalsPerTurn) return "budget_exhausted";
    if (!observer.triggers.includes(frame.trigger)) return "trigger";
    if (frame.stability.watermark < observer.minStability) return "stability";
    if (!languageMatches(observer.languages, frame.language.input_codes)) return "language";
    if (currentTime - entry.lastInvokedAt < observer.minIntervalMs) return "interval";
    if (frame.transcript.stable_revision === entry.lastStableRevision) return "unchanged";
    if (!qualityAccepted) return "quality_rejected";
    return "";
  }

  function dispatch(turn, state, frame, context) {
    const policy = context.policy;
    const currentTime = now();
    // The guard runs here as an extra filter on the observation path. It still
    // runs unchanged on the final transcript at commit; this never replaces it.
    const qualityAccepted = !frame.transcript.stable_text
      || inspectTranscriptScript(frame.transcript.stable_text, frame.language.input_codes).accepted;
    for (const observer of observers.values()) {
      const entry = observerState(state, observer.id);
      const declined = admits(observer, entry, frame, policy, currentTime, qualityAccepted);
      if (declined) continue;
      if (entry.inFlight) {
        // Coalesce: a slow observer sees the newest state, never a backlog.
        entry.pendingFrame = frame;
        continue;
      }
      entry.lastInvokedAt = currentTime;
      entry.lastStableRevision = frame.transcript.stable_revision;
      void invoke(turn, state, observer, entry, frame, context);
    }
  }

  async function invoke(turn, state, observer, entry, frame, context) {
    const controller = new AbortController();
    const budget = { ...frame.budget, latency_ms: observer.maxLatencyMs, proposals_remaining: observer.maxProposalsPerTurn - entry.proposals };
    const scoped = Object.freeze({ ...frame, budget: Object.freeze(budget) });
    entry.inFlight = controller;
    let timer = null;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => observer.observe(scoped, { signal: controller.signal })),
        new Promise((_, reject) => {
          timer = schedule(() => reject(new ObserverTimeoutError(observer.id)), observer.maxLatencyMs);
        }),
      ]);
      if (result) accept(turn, state, observer, entry, scoped, result, context);
    } catch (error) {
      entry.strikes += 1;
      await context.record("voice_observer_fault", {
        observer_id: observer.id,
        fault: error instanceof ObserverTimeoutError ? "timeout" : "error",
        strikes: entry.strikes,
        latency_budget_ms: observer.maxLatencyMs,
      });
      if (entry.strikes >= MAX_STRIKES) {
        quarantined.add(observer.id);
        await context.record("voice_observer_quarantined", { observer_id: observer.id, strikes: entry.strikes });
      }
    } finally {
      controller.abort();
      if (timer) clearTimeout(timer);
      entry.inFlight = null;
      const pending = entry.pendingFrame;
      entry.pendingFrame = null;
      if (pending && !quarantined.has(observer.id)) {
        const declined = admits(observer, entry, pending, context.policy, now(), true);
        if (!declined) {
          entry.lastInvokedAt = now();
          entry.lastStableRevision = pending.transcript.stable_revision;
          void invoke(turn, state, observer, entry, pending, context);
        }
      }
    }
  }

  function accept(turn, state, observer, entry, frame, raw, context) {
    entry.proposals += 1;
    state.pendingProposals.push({
      version: PROPOSAL_VERSION,
      proposal_id: `prop_${observer.id}_${frame.sequence}`,
      observer_id: observer.id,
      priority: observer.priority,
      trigger: frame.trigger,
      partial_safe: observer.partialSafe,
      quotes_user: observer.quotesUser,
      observer_max_delivery: observer.maxDelivery,
      allow_defer_fallback: observer.allowDeferFallback,
      transcript_revision: frame.transcript.revision,
      stable_revision: frame.transcript.stable_revision,
      stability_watermark: frame.stability.watermark,
      proposed_at: now(),
      mode_request: raw.mode_request,
      text: raw.text,
      speech_text: raw.speech_text,
      urgency: raw.urgency,
      confidence: raw.confidence,
      ttl_ms: raw.ttl_ms,
      reason_code: raw.reason_code,
      // Trusted only as a claim. The arbiter verifies it against the prefixes
      // the plane actually served.
      stable_digest: raw.stable_digest || (raw.used_tail === true ? "" : digestOf(frame.transcript.stable_text)),
    });
    if (state.windowTimer) return;
    state.windowTimer = schedule(() => {
      state.windowTimer = null;
      void arbitrate(turn, state, context);
    }, arbitrationWindowMs);
  }

  async function arbitrate(turn, state, context) {
    const proposals = state.pendingProposals;
    state.pendingProposals = [];
    if (!proposals.length) return;
    const decisions = decide(proposals, {
      now: now(),
      policy: context.policy,
      turnStatus: turn.status,
      currentRevision: state.revision,
      maxRevisionDrift,
      stableChain: state.stableChain,
      retiredDigests: state.retiredDigests,
      ...context.turnContext(turn),
    });
    for (const decision of decisions) {
      await context.record("voice_observer_delivery", deliveryReceipt(decision));
      if (decision.mode === "drop") {
        // A bubble already on screen for a proposal whose words were rewritten
        // has to come back off. Spoken audio cannot be retracted, which is
        // exactly why speaking needs the higher watermark.
        if (decision.drop_reason === "revised" && state.delivered.has(decision.proposal_id)) {
          state.delivered.delete(decision.proposal_id);
          await context.emit({
            type: "observer_retract",
            session_id: turn.sessionId,
            branch_id: turn.branchId,
            turn_id: turn.turnId,
            proposal_id: decision.proposal_id,
          });
        }
        continue;
      }
      state.delivered.set(decision.proposal_id, decision.mode);
      await context.emit({
        type: "observer_delivery",
        session_id: turn.sessionId,
        branch_id: turn.branchId,
        turn_id: turn.turnId,
        ...decision,
      });
    }
  }

  return {
    register(spec) {
      const observer = registerSpec(spec);
      if (observers.has(observer.id)) {
        throw new Error(`voice observer ${observer.id} is already registered`);
      }
      observers.set(observer.id, observer);
      return observer;
    },
    registered() {
      return Array.from(observers.keys());
    },
    quarantinedIds() {
      return Array.from(quarantined);
    },
    // Synchronous and void by design: the voice turn never awaits an observer.
    note(turn, text, input = {}) {
      const state = stateFor(turn);
      const changed = advanceTranscript(state, text);
      if (!changed && input.trigger !== "final") return state.revision;
      const context = input.context;
      if (!context || !context.policy?.enabled) return state.revision;
      const frame = buildFrame(turn, state, input);
      dispatch(turn, state, frame, context);
      return state.revision;
    },
    stop(turn) {
      const state = states.get(turn);
      if (!state) return;
      if (state.windowTimer) {
        clearTimeout(state.windowTimer);
        state.windowTimer = null;
      }
      state.pendingProposals = [];
      for (const entry of state.observers.values()) {
        entry.pendingFrame = null;
        entry.inFlight?.abort();
      }
    },
    currentStableDigest(turn) {
      return digestOf(stateFor(turn).stableText);
    },
  };
}

// The proof observer: no model call, no network, no wording dependency. It
// exists to demonstrate the whole path end to end and to anchor the tests.
function createWordCountObserver(options = {}) {
  const threshold = bounded(options.threshold, 40);
  return {
    id: "word-count",
    version: 1,
    priority: 1,
    triggers: ["pause", "final"],
    minStability: 0.5,
    minIntervalMs: bounded(options.minIntervalMs, 4000),
    maxProposalsPerTurn: 2,
    maxLatencyMs: 100,
    partialSafe: true,
    quotesUser: false,
    maxDelivery: "overlay",
    allowDeferFallback: true,
    observe(frame) {
      if (frame.transcript.words < threshold) return null;
      return {
        mode_request: "overlay",
        text: `that is ${frame.transcript.words} words so far`,
        urgency: 0.2,
        confidence: 1,
        ttl_ms: 4000,
        reason_code: "length",
      };
    },
  };
}

// Session wiring, in the same shape as the phrase-assist bridge next to it.
function createVoiceObserverSessionBridge(connection, options = {}) {
  const plane = options.observerPlane || createVoiceObserverPlane(options.observerPlaneOptions || {});
  for (const spec of Array.isArray(options.voiceObservers) ? options.voiceObservers : []) {
    plane.register(spec);
  }
  return {
    plane,
    configureTurn(turn, declaration, profile) {
      turn.observerPolicy = normalizeObserverPolicy(
        declaration && typeof declaration === "object" ? declaration : profile?.voice_observer_policy,
        { responseModality: profile?.response_modality },
      );
    },
    capability(turn) {
      return {
        version: 1,
        enabled: Boolean(turn.observerPolicy?.enabled),
        max_delivery: turn.observerPolicy?.max_delivery || "defer",
        observers: plane.registered(),
      };
    },
    note(turn, text, trigger) {
      if (!turn?.observerPolicy?.enabled) return;
      plane.note(turn, text, {
        trigger,
        languages: turn.inputLanguages || [],
        replyLanguage: turn.replyLanguage || "",
        floorHolder: turn.status === "recording" ? "user" : "assistant",
        replyInFlight: turn.status === "committed" || turn.status === "playback",
        context: {
          policy: turn.observerPolicy,
          emit: (payload) => connection.sendEvent(payload),
          record: (type, payload) => connection.recordProviderEvent(
            turn, turn.providerEvents || connection.createProviderEvents(turn), type, payload),
          turnContext: (current) => ({
            replyInFlight: current.status === "committed" || current.status === "playback",
            msSinceReplyEnd: Number(current.lastReplyEndedMs ?? Infinity),
            floorHolder: current.status === "recording" ? "user" : "assistant",
            scripts: scriptsFor(current.inputLanguages || []),
            hostedTtsAvailable: current.hostedTtsAvailable !== false,
            qualityAccepted: true,
          }),
        },
      });
    },
    stop(turn) {
      plane.stop(turn);
    },
  };
}

class ObserverTimeoutError extends Error {
  constructor(id) {
    super(`voice observer ${id} exceeded its latency budget`);
    this.name = "ObserverTimeoutError";
  }
}

function languageCodes(languages) {
  return (Array.isArray(languages) ? languages : [])
    .map((code) => String(code || "").trim().toLowerCase())
    .filter(Boolean);
}

function scriptsFor(languages) {
  const scripts = new Set();
  for (const code of languageCodes(languages)) {
    if (code === "auto") continue;
    if (code.startsWith("am") || code.startsWith("ti")) scripts.add("ethiopic");
    else if (code.startsWith("hi")) scripts.add("devanagari");
    else if (code.startsWith("bn")) scripts.add("bengali");
    else scripts.add("latin");
  }
  return Array.from(scripts);
}

function languageMatches(declared, codes) {
  if (declared.includes("*")) return true;
  if (!codes.length) return true;
  return codes.some((code) => declared.some((prefix) => code.startsWith(prefix)));
}

function longestCommonPrefix(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return right.slice(0, index);
}

function normalizeTranscript(value) {
  return String(value || "").trim().replace(/\s+/gu, " ").slice(-MAX_TRANSCRIPT_CHARS);
}

function clamp01(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

function bounded(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

module.exports = {
  OBSERVATION_VERSION,
  PROPOSAL_VERSION,
  TRIGGERS,
  createVoiceObserverPlane,
  createVoiceObserverSessionBridge,
  createWordCountObserver,
  digestOf,
};
