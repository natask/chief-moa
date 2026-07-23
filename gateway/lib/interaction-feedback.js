"use strict";

function createInteractionFeedbackContract(helpers = {}) {
  const {
    deploymentRef,
    deploymentString,
    iso,
    refs,
    text,
    workHistoryRef,
  } = helpers;

  function boundedRawText(value, max) {
    if (value === undefined || value === null) return "";
    return String(value).slice(0, max);
  }

  function deploymentRefs(value, name) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error(`${name} must be an array of typed string references`);
    if (value.length > 50) throw new Error(`${name} exceeds 50 references`);
    return value.map((item, index) => deploymentRef(item, `${name}[${index}]`)).filter(Boolean);
  }

  function deploymentUrl(value, name) {
    const url = deploymentString(value, name, 800, false);
    if (!url) return "";
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error(`${name} must be an https URL`); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error(`${name} must be an https URL without credentials`);
    }
    return url;
  }

  function deploymentCandidateRefs(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => {
        if (typeof item === "string") {
          return { candidate_id: deploymentString(item, "candidate_id", 160, true) };
        }
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const releaseId = deploymentString(item.release_id || item.releaseId, "candidate release_id", 160);
        const artifactSha256 = deploymentSha256(item.artifact_sha256 || item.artifactSha256, "candidate artifact_sha256");
        const candidate = {
          candidate_id: deploymentString(item.candidate_id || item.candidateId || item.id, "candidate_id", 160),
          target: deploymentString(item.target, "candidate target", 120),
          ...(releaseId ? { release_id: releaseId } : {}),
          ...(artifactSha256 ? { artifact_sha256: artifactSha256 } : {}),
          artifact_ref: deploymentRef(item.artifact_ref || item.artifactRef, "candidate artifact_ref"),
          provenance_ref: deploymentRef(item.provenance_ref || item.provenanceRef, "candidate provenance_ref"),
        };
        return candidate.candidate_id || candidate.target || candidate.release_id || candidate.artifact_ref ? candidate : null;
      })
      .filter(Boolean)
      .slice(0, 20);
  }

  function deploymentSha256(value, name) {
    if (value === undefined || value === null || value === "") return "";
    const digest = deploymentString(value, name, 64, true).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
    return digest;
  }

  function normalizeInteractionFeedback(value, context) {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("interaction_feedback must be an object");
    }
    const schema = String(value.schema || "interaction_feedback.v1");
    if (schema !== "interaction_feedback.v1") {
      throw new Error("interaction_feedback.schema must be interaction_feedback.v1");
    }
    const evidenceRefs = refs(value.evidence_refs || value.evidenceRefs);
    const anchors = normalizeInteractionAnchors(value.anchors);
    const releaseBinding = normalizeReleaseBinding(value.release_binding || value.releaseBinding);
    validateReleaseBindingAgainstTargets(releaseBinding, context.targets, context.state);
    const proposalText = [
      context.rawComment ? `User comment: ${context.rawComment}` : "User comment: (none)",
      `Release: ${releaseBinding.surface}/${releaseBinding.release_id}`,
      `Candidate: ${releaseBinding.candidate_id} @ ${releaseBinding.artifact_sha256}`,
      evidenceRefs.length ? `Evidence: ${evidenceRefs.join(", ")}` : "",
      anchors.length ? `Anchors: ${anchors.map(describeInteractionAnchor).join("; ")}` : "",
    ].filter(Boolean).join("\n");
    return {
      schema,
      evidence_refs: evidenceRefs,
      anchors,
      release_binding: releaseBinding,
      context_proposal: {
        status: "unreviewed",
        derivation: "deterministic_v1",
        text: proposalText.slice(0, 12_000),
      },
    };
  }

  function normalizeInteractionAnchors(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error("interaction_feedback.anchors must be an array");
    if (value.length > 50) throw new Error("interaction_feedback.anchors exceeds 50 items");
    return value.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`interaction_feedback.anchors[${index}] must be an object`);
      }
      if (item.kind === "time_range") {
        const startMs = boundedMilliseconds(item.start_ms, `anchors[${index}].start_ms`);
        const endMs = boundedMilliseconds(item.end_ms ?? item.start_ms, `anchors[${index}].end_ms`);
        if (endMs < startMs) throw new Error(`anchors[${index}].end_ms cannot precede start_ms`);
        return { kind: "time_range", start_ms: startMs, end_ms: endMs };
      }
      if (item.kind === "browser_snapshot") {
        const snapshotId = deploymentString(item.snapshot_id, `anchors[${index}].snapshot_id`, 160, true);
        const capturedAt = iso(item.captured_at, "");
        if (!capturedAt) throw new Error(`anchors[${index}].captured_at must be an RFC3339 timestamp`);
        return {
          kind: "browser_snapshot",
          snapshot_id: snapshotId,
          captured_at: capturedAt,
          page_ref: workHistoryRef(item.page_ref, `anchors[${index}].page_ref`),
          element_index: optionalBoundedInteger(item.element_index, `anchors[${index}].element_index`, 10_000),
          label: text(item.label, 200),
        };
      }
      throw new Error(`interaction_feedback.anchors[${index}].kind is unsupported`);
    });
  }

  function boundedMilliseconds(value, name) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > 24 * 60 * 60 * 1000) {
      throw new Error(`${name} must be a non-negative bounded integer`);
    }
    return number;
  }

  function optionalBoundedInteger(value, name, max) {
    if (value === undefined || value === null || value === "") return null;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > max) {
      throw new Error(`${name} must be a non-negative bounded integer`);
    }
    return number;
  }

  function normalizeReleaseBinding(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("interaction_feedback.release_binding is required");
    }
    return {
      surface: deploymentString(value.surface, "release_binding.surface", 120, true),
      release_id: deploymentString(value.release_id || value.releaseId, "release_binding.release_id", 160, true),
      candidate_id: deploymentString(value.candidate_id || value.candidateId, "release_binding.candidate_id", 160, true),
      artifact_sha256: deploymentSha256(
        value.artifact_sha256 || value.artifactSha256,
        "release_binding.artifact_sha256",
      ),
      channel: deploymentString(value.channel, "release_binding.channel", 120),
      assignment_id: deploymentString(value.assignment_id || value.assignmentId, "release_binding.assignment_id", 160),
    };
  }

  function validateReleaseBindingAgainstTargets(binding, targets, state) {
    const deploymentTargets = targets.filter((target) => target.type === "deployment");
    if (deploymentTargets.length !== 1) {
      throw new Error("interaction feedback release binding requires exactly one deployment target");
    }
    const requestId = deploymentRequestIdForTarget({
      targetId: deploymentTargets[0].id,
      deploymentRequests: state.deploymentRequests,
      deployments: state.deployments,
    });
    const entry = requestId ? state.deploymentRequests.get(requestId) : null;
    if (!entry) throw new Error("interaction feedback deployment target was not found");
    const candidate = (entry.request.candidate_refs || []).find((item) =>
      item.candidate_id === binding.candidate_id
      && item.release_id === binding.release_id
      && item.artifact_sha256 === binding.artifact_sha256
      && (!item.target || item.target === binding.surface)
    );
    if (!candidate) throw new Error("interaction feedback release binding does not match the targeted candidate");
  }

  function deploymentRequestIdForTarget({ targetId, deploymentRequests, deployments }) {
    if (deploymentRequests.has(targetId)) return targetId;
    const deployment = deployments.get(targetId);
    return deployment?.request_id && deploymentRequests.has(deployment.request_id)
      ? deployment.request_id
      : "";
  }

  function describeInteractionAnchor(anchor) {
    if (anchor.kind === "time_range") return `${anchor.start_ms}-${anchor.end_ms}ms`;
    return `${anchor.snapshot_id}${anchor.element_index == null ? "" : `#${anchor.element_index}`}`;
  }

  return Object.freeze({
    boundedRawText,
    deploymentCandidateRefs,
    deploymentRefs,
    deploymentRequestIdForTarget,
    deploymentUrl,
    normalizeInteractionFeedback,
  });
}

module.exports = { createInteractionFeedbackContract };
