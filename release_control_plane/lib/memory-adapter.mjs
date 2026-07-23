"use strict";

export function createMemoryReleaseAdapter(seed = {}) {
  const state = {
    bundles: structuredClone(seed.bundles || []),
    channel_heads: structuredClone(seed.channel_heads || []),
    assignment_events: structuredClone(seed.assignment_events || []),
    install_receipts: structuredClone(seed.install_receipts || []),
    feedback: structuredClone(seed.feedback || []),
  };

  return Object.freeze({
    async listBundles(tenantId, applicationId) {
      return clone(state.bundles.filter((item) => item.tenant_id === tenantId && item.application_id === applicationId));
    },
    async listChannelHeads(tenantId, applicationId) {
      return clone(state.channel_heads.filter((item) => item.tenant_id === tenantId && item.application_id === applicationId));
    },
    async listAssignmentEvents(tenantId, applicationId) {
      return clone(state.assignment_events.filter((item) => item.tenant_id === tenantId && item.application_id === applicationId));
    },
    async appendAssignmentEvent(event, expectedSequence) {
      const current = state.assignment_events
        .filter((item) => item.tenant_id === event.tenant_id
          && item.application_id === event.application_id
          && item.scope_type === event.scope_type
          && item.scope_id === event.scope_id)
        .reduce((maximum, item) => Math.max(maximum, Number(item.sequence) || 0), 0);
      if (current !== expectedSequence) throw sequenceConflict(expectedSequence, current);
      state.assignment_events.push(clone(event));
      return clone(event);
    },
    async listInstallReceipts(tenantId, applicationId) {
      return clone(state.install_receipts.filter((item) => item.tenant_id === tenantId && item.application_id === applicationId));
    },
    async appendInstallReceipt(receipt) {
      appendUnique(state.install_receipts, receipt, "receipt_id");
      return clone(receipt);
    },
    async listFeedback(tenantId, applicationId) {
      return clone(state.feedback.filter((item) => item.tenant_id === tenantId && item.application_id === applicationId));
    },
    async appendFeedback(feedback) {
      appendUnique(state.feedback, feedback, "feedback_id");
      return clone(feedback);
    },
    snapshot() { return clone(state); },
  });
}

function appendUnique(records, record, key) {
  const existing = records.find((item) => item[key] === record[key]);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error(`${key} is immutable`);
    return;
  }
  records.push(clone(record));
}

function sequenceConflict(expected, actual) {
  const error = new Error(`assignment sequence conflict: expected ${expected}, actual ${actual}`);
  error.code = "assignment_sequence_conflict";
  error.expected_sequence = expected;
  error.actual_sequence = actual;
  return error;
}

function clone(value) {
  return structuredClone(value);
}
