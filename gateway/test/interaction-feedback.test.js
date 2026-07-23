"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createInteractionFeedbackContract } = require("../lib/interaction-feedback");
const { workHistoryTestInternals: helpers } = require("../lib/work-history");

function contract() {
  return createInteractionFeedbackContract({
    deploymentRef: helpers.deploymentRef,
    deploymentString: helpers.deploymentString,
    iso: helpers.iso,
    refs: helpers.refs,
    text: helpers.text,
    workHistoryRef: helpers.workHistoryRef,
  });
}

test("interaction feedback helpers cover empty input and candidate aliases", () => {
  const subject = contract();
  assert.equal(subject.boundedRawText(null, 4), "");
  assert.equal(subject.boundedRawText("abcdef", 4), "abcd");
  assert.deepEqual(subject.deploymentRefs(undefined, "refs"), []);
  assert.deepEqual(subject.deploymentCandidateRefs([{
    candidateId: "candidate",
    releaseId: "release",
    artifactSha256: "A".repeat(64),
  }]), [{
    candidate_id: "candidate",
    target: "",
    release_id: "release",
    artifact_sha256: "a".repeat(64),
    artifact_ref: "",
    provenance_ref: "",
  }]);
});

test("interaction feedback can resolve a deployment record to its exact candidate", () => {
  const subject = contract();
  const digest = "d".repeat(64);
  const deploymentRequests = new Map([["request", {
    request: {
      candidate_refs: [{
        candidate_id: "candidate",
        release_id: "release",
        artifact_sha256: digest,
        target: "",
      }],
    },
  }]]);
  const deployments = new Map([["deployment", { request_id: "request" }]]);
  const result = subject.normalizeInteractionFeedback({
    evidenceRefs: [],
    anchors: [{ kind: "time_range", start_ms: 5 }],
    releaseBinding: {
      surface: "gateway",
      releaseId: "release",
      candidateId: "candidate",
      artifactSha256: digest,
      assignmentId: "assignment",
    },
  }, {
    rawComment: "",
    targets: [{ type: "deployment", id: "deployment" }],
    state: { deploymentRequests, deployments },
  });

  assert.equal(result.anchors[0].end_ms, 5);
  assert.equal(result.release_binding.assignment_id, "assignment");
  assert.match(result.context_proposal.text, /User comment: \(none\)/);
});
