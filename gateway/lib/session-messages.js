"use strict";

// Generous per-message read bound. This is intentionally larger than the
// gateway's accepted 16 KiB voice transcript and preserves long typed product
// direction messages while keeping one history response bounded.
const SESSION_MESSAGE_TEXT_MAX_CHARS = 32_768;
const SESSION_MESSAGE_DEFAULT_LIMIT = 100;
const SESSION_MESSAGE_MAX_LIMIT = 200;

function projectSessionMessages(input = {}) {
  const sessionId = clean(input.sessionId || input.session_id);
  if (!sessionId) throw new Error("session_id is required");
  const branchId = clean(input.branchId || input.branch_id);
  const limit = boundedLimit(input.limit);
  const byKey = new Map();
  const counts = { voice: 0, chat: 0, browser: 0, broker: 0 };
  const excluded = { other_session: 0, other_branch: 0, incognito: 0, invalid: 0, unreadable: 0 };

  addRecords(input.voiceTurns, "voice", voiceCandidates);
  addRecords(input.chatTurns, "chat", chatCandidates);
  addRecords(input.browserTurns, "browser", browserCandidates);
  addRecords(input.brokerEvents, "broker", brokerCandidates);

  const all = [...byKey.values()]
    .map(finalizeMessage)
    .sort(compareMessages);
  const messages = all.slice(-limit);
  const included = countMessages(messages);
  return {
    version: "session_messages.v1",
    generated_at: new Date().toISOString(),
    session_id: sessionId,
    branch_id: branchId,
    limit,
    total: all.length,
    has_more: all.length > messages.length,
    messages,
    completeness: {
      complete: all.length <= messages.length,
      text_limit_chars: SESSION_MESSAGE_TEXT_MAX_CHARS,
      source_records: counts,
      included_messages: included,
      excluded_records: excluded,
    },
  };

  function addRecords(records, store, projector) {
    for (const record of array(records)) {
      const recordSession = clean(record?.session_id || record?.conversation_id);
      const recordBranch = clean(record?.branch_id) || "default";
      if (!record || typeof record !== "object") {
        inputExcluded("invalid");
      } else if (record.__session_message_unreadable === true) {
        inputExcluded("unreadable");
      } else if (privateRecord(record)) {
        inputExcluded("incognito");
      } else if (recordSession !== sessionId) {
        inputExcluded("other_session");
      } else if (branchId && recordBranch !== branchId) {
        inputExcluded("other_branch");
      } else {
        counts[store] += 1;
        for (const candidate of projector(record, { sessionId, recordBranch, store })) mergeCandidate(candidate);
      }
    }
  }

  function inputExcluded(reason) {
    excluded[reason] = Number(excluded[reason] || 0) + 1;
  }

  function mergeCandidate(candidate) {
    if (!candidate?.text) return;
    const previous = byKey.get(candidate.key);
    if (!previous) {
      byKey.set(candidate.key, candidate);
      return;
    }
    const preferred = candidate.priority > previous.priority ? candidate : previous;
    const secondary = preferred === candidate ? previous : candidate;
    byKey.set(candidate.key, {
      ...preferred,
      evidence: mergeEvidence(preferred.evidence, secondary.evidence),
      provenance: uniqueObjects([...preferred.provenance, ...secondary.provenance], "store", "record_id"),
    });
  }
}

function voiceCandidates(record, context) {
  const turnId = recordId(record, "voice");
  const base = baseCandidate(record, context, turnId, "voice", 40);
  const state = completionState(record, "completed");
  return speakerCandidates(base, record.transcript, assistantText(record), state);
}

function chatCandidates(record, context) {
  const linkedVoiceId = clean(record.voice_turn_id);
  const turnId = linkedVoiceId || clean(record.turn_id) || recordId(record, "chat");
  const kind = linkedVoiceId || record.generated_from_live_transcript === true ? "voice" : "text";
  const base = baseCandidate(record, context, turnId, kind, linkedVoiceId ? 20 : 35);
  return speakerCandidates(base, chatUserText(record), chatAssistantText(record), completionState(record, "completed"));
}

function browserCandidates(record, context) {
  const turnId = clean(record.turn_id || record.id) || recordId(record, "browser");
  const kind = clean(record.modality).toLowerCase() === "voice" || clean(record.transcript) ? "voice" : "text";
  const base = baseCandidate(record, context, turnId, kind, 40);
  return speakerCandidates(base, record.text || record.transcript, assistantText(record), completionState(record, "pending"));
}

function brokerCandidates(record, context) {
  const linkedTurnId = brokerLinkedTurnId(record);
  const recordIdValue = clean(record.id) || recordId(record, "broker");
  const turnId = linkedTurnId;
  const kind = inferKind(record.source, "text");
  const base = baseCandidate(record, context, turnId || recordIdValue, kind, 10, {
    keyPrefix: linkedTurnId ? "turn" : "broker",
    recordId: recordIdValue,
  });
  return speakerCandidates(base, record.text, "", completionState(record, "recorded"));
}

function speakerCandidates(base, userText, responseText, state) {
  const output = [];
  if (clean(userText)) output.push(speakerCandidate(base, "user", userText, state, base.created_at));
  if (clean(responseText)) {
    output.push(speakerCandidate(base, "assistant", responseText, state, base.assistant_at || base.created_at));
  }
  return output;
}

function speakerCandidate(base, speaker, value, state, createdAt) {
  const bounded = boundedText(value);
  return {
    ...base,
    key: `${base.key_prefix}:${base.session_id}:${base.branch_id}:${base.turn_id}:${speaker}`,
    message_id: `${base.key_prefix}:${base.session_id}:${base.branch_id}:${base.turn_id}:${speaker}`,
    speaker,
    text: bounded.text,
    created_at: clean(createdAt),
    completion_state: state,
    complete: state === "completed" || state === "recorded",
    text_complete: !bounded.truncated,
    text_truncated: bounded.truncated,
    stored_text_chars: bounded.originalLength,
    projected_text_chars: bounded.text.length,
  };
}

function baseCandidate(record, context, turnId, sourceKind, priority, options = {}) {
  const source = clean(record.source);
  const recordIdValue = clean(options.recordId || record.id || record.turn_id || turnId);
  return {
    key_prefix: options.keyPrefix || "turn",
    session_id: context.sessionId,
    conversation_id: clean(record.conversation_id) || context.sessionId,
    branch_id: context.recordBranch,
    turn_id: clean(turnId),
    source: source || context.store,
    source_surface: inferSurface(source, context.store),
    source_kind: sourceKind,
    classification: clean(record.classification) || (context.store === "chat" ? "chat" : context.store === "broker" ? "intent" : ""),
    created_at: clean(record.created_at || record.ts || record.updated_at),
    assistant_at: clean(record.completed_at || record.updated_at || record.created_at || record.ts),
    evidence: recordEvidence(record, context.store),
    provenance: [{ store: context.store, record_id: recordIdValue }],
    priority,
  };
}

function finalizeMessage(candidate) {
  const { key, key_prefix, priority, assistant_at, ...message } = candidate;
  return message;
}

function recordEvidence(record, store) {
  const references = record.references && typeof record.references === "object" ? record.references : {};
  return {
    broker_event_ids: uniqueStrings([record.broker_event_id, references.broker_event_id, store === "broker" ? record.id : ""]),
    agent_run_ids: uniqueStrings([...(array(record.agent_run_ids)), ...(array(references.agent_run_ids)), ...launchRunIds(record)]),
    work_task_ids: uniqueStrings([...(array(record.task_ids)), record.task_id, references.task_id]),
    proposal_ids: uniqueStrings(array(record.proposal_ids)),
    receipt_ids: uniqueStrings(array(record.receipt_ids)),
  };
}

function mergeEvidence(left = {}, right = {}) {
  const output = {};
  for (const key of ["broker_event_ids", "agent_run_ids", "work_task_ids", "proposal_ids", "receipt_ids"]) {
    output[key] = uniqueStrings([...(array(left[key])), ...(array(right[key]))]);
  }
  return output;
}

function launchRunIds(record) {
  const refs = [...array(record.launch_refs), ...array(record.decisions).map((item) => item?.launch)];
  return refs.map((item) => item?.agent_run_id).filter(Boolean);
}

function brokerLinkedTurnId(record) {
  const direct = clean(record.turn_id || record.created_from_turn_id || record.source_turn_id);
  if (direct) return direct;
  for (const ref of array(record.evidence_refs)) {
    const id = clean(ref?.turn_id || ref?.message_id);
    if (id) return id;
  }
  return "";
}

function completionState(record, fallback) {
  const voice = record.references?.voice_session || {};
  const raw = clean(record.completion_state || record.status || voice.status || record.classification).toLowerCase();
  if (record.incomplete === true || voice.incomplete === true || raw === "interrupted" || raw === "incomplete") return "incomplete";
  if (raw === "canceled" || raw === "cancelled") return "canceled";
  if (raw === "failed" || raw === "error" || raw === "timed-out") return "failed";
  if (raw === "queued" || raw === "running" || raw === "needs_evidence" || raw === "pending") return "pending";
  return raw === "completed" || raw === "complete" || raw === "chat" ? "completed" : fallback;
}

function assistantText(record) {
  return firstPresentText(record.response?.display, record.response?.text, record.response?.speak, record.assistant_text);
}

function chatAssistantText(record) {
  return firstPresentText(record.response_text, record.response?.text, record.response?.display);
}

function chatUserText(record) {
  if (clean(record.user_text)) return record.user_text;
  for (let index = array(record.request_messages).length - 1; index >= 0; index -= 1) {
    const message = record.request_messages[index];
    if (message?.role === "user" && typeof message.content === "string") return message.content;
  }
  return "";
}

function inferSurface(source, store) {
  const value = clean(source).toLowerCase();
  if (store === "browser" || /browser|extension|chrome/.test(value)) return "browser";
  if (/android|phone|mobile|overlay/.test(value)) return "android";
  return "unknown";
}

function inferKind(source, fallback) {
  return /voice|speech|audio/.test(clean(source).toLowerCase()) ? "voice" : fallback;
}

function privateRecord(record) {
  const branch = clean(record.branch_id);
  return record.incognito === true || record.persisted === false || Boolean(record.deleted_at) || branch.startsWith("inc-");
}

function recordId(record, fallback) {
  return clean(record.id || record.turn_id || record.event_id || record.created_at || record.ts) || fallback;
}

function boundedText(value) {
  const raw = String(value || "");
  return {
    text: raw.slice(0, SESSION_MESSAGE_TEXT_MAX_CHARS),
    truncated: raw.length > SESSION_MESSAGE_TEXT_MAX_CHARS,
    originalLength: raw.length,
  };
}

function firstPresentText(...values) {
  for (const value of values) {
    if (value != null && String(value).trim()) return String(value);
  }
  return "";
}

function compareMessages(left, right) {
  return clean(left.created_at).localeCompare(clean(right.created_at))
    || speakerOrder(left.speaker) - speakerOrder(right.speaker)
    || clean(left.message_id).localeCompare(clean(right.message_id));
}

function speakerOrder(value) { return value === "user" ? 0 : 1; }

function countMessages(messages) {
  const counts = { total: messages.length, user: 0, assistant: 0, android: 0, browser: 0, unknown: 0, text: 0, voice: 0 };
  for (const message of messages) {
    counts[message.speaker] = Number(counts[message.speaker] || 0) + 1;
    counts[message.source_surface] = Number(counts[message.source_surface] || 0) + 1;
    counts[message.source_kind] = Number(counts[message.source_kind] || 0) + 1;
  }
  return counts;
}

function boundedLimit(value) {
  if (value == null || value === "") return SESSION_MESSAGE_DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > SESSION_MESSAGE_MAX_LIMIT) {
    throw new RangeError("invalid session message limit");
  }
  return parsed;
}

function uniqueStrings(values) {
  return [...new Set(array(values).map(clean).filter(Boolean))].slice(0, 40);
}

function uniqueObjects(values, ...keys) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keys.map((name) => clean(value?.[name])).join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

function array(value) { return Array.isArray(value) ? value : []; }
function clean(value) { return value == null ? "" : String(value).trim(); }

module.exports = {
  SESSION_MESSAGE_DEFAULT_LIMIT,
  SESSION_MESSAGE_MAX_LIMIT,
  SESSION_MESSAGE_TEXT_MAX_CHARS,
  projectSessionMessages,
};
