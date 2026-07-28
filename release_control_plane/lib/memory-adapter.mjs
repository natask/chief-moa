"use strict";

export function createMemoryReleaseAdapter(seed = {}) {
  const state = {
    bundles: structuredClone(seed.bundles || []),
    channel_heads: structuredClone(seed.channel_heads || []),
    assignment_events: structuredClone(seed.assignment_events || []),
    install_receipts: structuredClone(seed.install_receipts || []),
    feedback: structuredClone(seed.feedback || []),
    publication_receipts: structuredClone(seed.publication_receipts || []),
  };

  return Object.freeze({
    async listBundles(tenantId, applicationId) {
      return clone(state.bundles.filter((item) => item.tenant_id === tenantId && item.application_id === applicationId));
    },
    async listPublishedBundles(tenantId, applicationId) {
      const published = new Set(state.publication_receipts
        .filter((item) => item.tenant_id === tenantId && item.application_id === applicationId)
        .map((item) => item.bundle_id));
      return clone(state.bundles.filter((item) => item.tenant_id === tenantId
        && item.application_id === applicationId && published.has(item.bundle_id)));
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
    async publishBundleAndChannelHead({ bundle, head, receipt, expected_head_sequence: expectedSequence }) {
      validatePublicationCoordinates(bundle, head, receipt);
      const priorReceipt = state.publication_receipts.find((item) => item.tenant_id === receipt.tenant_id
        && item.application_id === receipt.application_id
        && item.receipt_id === receipt.receipt_id);
      if (priorReceipt) {
        const priorBundle = state.bundles.find((item) => item.tenant_id === bundle.tenant_id
          && item.application_id === bundle.application_id && item.bundle_id === bundle.bundle_id);
        const priorHead = state.channel_heads.find((item) => item.tenant_id === head.tenant_id
          && item.application_id === head.application_id && item.channel === head.channel
          && item.sequence === head.sequence);
        if (!priorBundle || !priorHead
            || JSON.stringify(priorReceipt) !== JSON.stringify(receipt)
            || JSON.stringify(priorBundle) !== JSON.stringify(bundle)
            || JSON.stringify(priorHead) !== JSON.stringify(head)) {
          throw new Error("publication receipt is immutable");
        }
        return clone({ bundle: priorBundle, head: priorHead, receipt: priorReceipt });
      }
      const current = state.channel_heads
        .filter((item) => item.tenant_id === head.tenant_id
          && item.application_id === head.application_id
          && item.channel === head.channel)
        .reduce((maximum, item) => Math.max(maximum, Number(item.sequence) || 0), 0);
      if (current !== expectedSequence || head.sequence !== current + 1) {
        throw channelSequenceConflict(expectedSequence, current);
      }
      const priorBundle = state.bundles.find((item) => item.tenant_id === bundle.tenant_id
        && item.application_id === bundle.application_id
        && item.bundle_id === bundle.bundle_id);
      if (priorBundle && JSON.stringify(priorBundle) !== JSON.stringify(bundle)) {
        throw new Error("bundle_id is immutable");
      }
      if (!priorBundle) state.bundles.push(clone(bundle));
      state.channel_heads.push(clone(head));
      state.publication_receipts.push(clone(receipt));
      return clone({ bundle, head, receipt });
    },
    async listPublicationReceipts(tenantId, applicationId) {
      return clone(state.publication_receipts.filter((item) => item.tenant_id === tenantId
        && item.application_id === applicationId));
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

function channelSequenceConflict(expected, actual) {
  const error = new Error(`channel head sequence conflict: expected ${expected}, actual ${actual}`);
  error.code = "channel_head_sequence_conflict";
  error.expected_sequence = expected;
  error.actual_sequence = actual;
  return error;
}

function validatePublicationCoordinates(bundle, head, receipt) {
  if (!["stable", "preview"].includes(head.channel)) throw new Error("channel is invalid");
  for (const record of [head, receipt]) {
    if (record.tenant_id !== bundle.tenant_id
        || record.application_id !== bundle.application_id
        || record.bundle_id !== bundle.bundle_id) {
      throw new Error("publication coordinates do not match");
    }
  }
  if (receipt.channel !== head.channel || receipt.new_sequence !== head.sequence) {
    throw new Error("publication coordinates do not match");
  }
}

function clone(value) {
  return structuredClone(value);
}
