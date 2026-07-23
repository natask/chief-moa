import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAssignmentRequest,
  buildFallbackRequest,
  buildFeedbackRequest,
  buildInstallReceiptRequest,
  deriveReleaseCockpitState,
  parseAssignmentMutationResponse,
  parseReleaseControlView,
} from "../extension/release-control-runtime.js";

const stableDigest = "a".repeat(64);
const previewDigest = "b".repeat(64);

function fixture() {
  const stable = {
    bundle_id: "bundle_stable",
    release_id: "release_stable",
    channel: "stable",
    source_ref: "refs/heads/master",
    artifact: {
      surface: "browser_extension",
      sha256: stableDigest,
      size_bytes: 1234,
      version: "0.1.85",
      git_sha: "a1b2c3d4",
    },
    compatibility: { eligible: true, reasons: [] },
    readiness: { ready: true, status: "ready", blockers: [] },
  };
  const preview = {
    bundle_id: "bundle_preview",
    release_id: "release_preview",
    channel: "preview",
    source_ref: "refs/heads/release-preview",
    artifact: {
      surface: "browser_extension",
      sha256: previewDigest,
      size_bytes: 2345,
      version: "0.1.86",
      download_url: "https://downloads.example.test/agee-0.1.86.zip",
      git_sha: "b1c2d3e4",
    },
    compatibility: { eligible: true, reasons: ["protocol N supported"] },
    readiness: { ready: false, status: "install_pending", blockers: ["browser reload"] },
  };
  return {
    schema_version: 1,
    application_id: "chief-moa",
    installed: {
      surface: "browser_extension",
      release_id: "release_stable",
      artifact_sha256: stableDigest,
      version: "0.1.85",
      git_sha: "a1b2c3d4",
      status: "activated",
    },
    effective_assignment: {
      assignment_id: "assignment_7",
      sequence: 7,
      scope: "device",
      channel: "preview",
      bundle_id: "bundle_preview",
      release_id: "release_preview",
      feature_profile_id: null,
    },
    channels: {
      stable: {
        sequence: 4,
        bundle: { bundle_id: "bundle_stable", release_id: "release_stable" },
      },
      preview: {
        sequence: 8,
        bundle: { bundle_id: "bundle_preview", release_id: "release_preview" },
      },
    },
    last_known_good: {
      assignment_id: "assignment_4",
      bundle_id: "bundle_stable",
      release_id: "release_stable",
    },
    candidates: [stable, preview],
  };
}

test("strictly parses exact release bindings and derives loaded versus selected state", () => {
  const view = parseReleaseControlView(fixture());
  const state = deriveReleaseCockpitState(view, "0.1.85");
  assert.equal(state.current.release_id, "release_preview");
  assert.equal(state.stable.artifact.sha256, stableDigest);
  assert.equal(state.preview.artifact.sha256, previewDigest);
  assert.equal(state.loaded_version_matches_assignment, false);
  assert.equal(state.digest_proven_locally, false);
  assert.equal(state.install_reload_pending, true);
  assert.equal(state.feedback_binding_proven, false);
});

test("rejects incomplete, cross-app, malformed-digest, and unbound assignment views", () => {
  const missing = fixture();
  delete missing.candidates[1].artifact.sha256;
  assert.throws(() => parseReleaseControlView(missing), /candidates\[1\]\.artifact\.sha256/);

  const crossApp = fixture();
  crossApp.application_id = "another-app";
  assert.throws(() => parseReleaseControlView(crossApp), /application_id/);

  const malformed = fixture();
  malformed.installed.artifact_sha256 = "not-a-digest";
  assert.throws(() => parseReleaseControlView(malformed), /installed\.artifact_sha256/);

  const unbound = fixture();
  unbound.effective_assignment.release_id = "release_absent";
  assert.throws(() => parseReleaseControlView(unbound), /absent from candidates/);
});

test("builds sequence-bound assignment and stable fallback requests", () => {
  const view = parseReleaseControlView(fixture());
  const stable = view.candidates[0];
  assert.deepEqual(buildAssignmentRequest(view, stable, "browser_device1", "nonce1"), {
    device_id: "browser_device1",
    surface: "browser_extension",
    expected_assignment_sequence: 7,
    channel: "stable",
    bundle_id: "bundle_stable",
    release_id: "release_stable",
    idempotency_key: "browser_assign_nonce1",
  });
  assert.deepEqual(buildFallbackRequest(view, "browser_device1", "nonce2"), {
    device_id: "browser_device1",
    surface: "browser_extension",
    expected_assignment_sequence: 7,
    idempotency_key: "browser_fallback_nonce2",
  });
});

test("binds feedback to the exact current browser artifact", () => {
  const raw = fixture();
  raw.installed = {
    surface: "browser_extension",
    release_id: "release_preview",
    artifact_sha256: previewDigest,
    version: "0.1.86",
    git_sha: "b1c2d3e4",
    status: "activated",
  };
  const view = parseReleaseControlView(raw);
  assert.deepEqual(buildFeedbackRequest(view, "browser_device1", "The preview controls overlap.", ["capture_42"], {
    digest_proven: true,
    release_id: "release_preview",
    artifact_sha256: previewDigest,
    version: "0.1.86",
    status: "activated",
  }, "nonce3"), {
    assignment_id: "assignment_7",
    device_id: "browser_device1",
    bundle_id: "bundle_preview",
    release_id: "release_preview",
    surface: "browser_extension",
    artifact_sha256: previewDigest,
    text: "The preview controls overlap.",
    evidence_refs: ["capture_42"],
    idempotency_key: "browser_feedback_nonce3",
  });
});

test("does not label feedback as preview while stable extension bytes remain loaded", () => {
  const view = parseReleaseControlView(fixture());
  assert.throws(
    () => buildFeedbackRequest(view, "browser_device1", "This is actually about stable.", [], {
      digest_proven: false,
    }, "nonce_pending"),
    /disabled until the exact assigned browser release is installed/,
  );
});

test("accepts an unassigned bootstrap view with nullable channel heads", () => {
  const raw = fixture();
  raw.effective_assignment = null;
  raw.last_known_good = null;
  raw.channels.stable = null;
  raw.channels.preview = null;
  const view = parseReleaseControlView(raw);
  const state = deriveReleaseCockpitState(view, "0.1.85");
  assert.equal(state.current, null);
  assert.equal(state.stable, null);
  assert.equal(state.preview, null);
  assert.equal(buildAssignmentRequest(view, view.candidates[1], "browser_device1", "bootstrap").expected_assignment_sequence, 0);
  assert.throws(() => buildFallbackRequest(view, "browser_device1", "bootstrap"), /No release assignment/);
});

test("never creates a browser install receipt without exact local digest proof", () => {
  const view = parseReleaseControlView(fixture());
  assert.throws(() => buildInstallReceiptRequest(view, {
    device_id: "browser_device1",
    version: "0.1.86",
    artifact_sha256: previewDigest,
    digest_proven: false,
  }, "activated", "nonce4"), /not proven/);

  assert.deepEqual(buildInstallReceiptRequest(view, {
    device_id: "browser_device1",
    version: "0.1.86",
    artifact_sha256: previewDigest,
    digest_proven: true,
  }, "activated", "nonce4"), {
    device_id: "browser_device1",
    assignment_id: "assignment_7",
    bundle_id: "bundle_preview",
    release_id: "release_preview",
    surface: "browser_extension",
    artifact_sha256: previewDigest,
    version: "0.1.86",
    status: "activated",
    idempotency_key: "browser_install_nonce4",
  });
});

test("rejects an incompatible candidate before assignment", () => {
  const raw = fixture();
  raw.candidates[0].compatibility = { eligible: false, reasons: ["Chrome version too old"] };
  const view = parseReleaseControlView(raw);
  assert.throws(
    () => buildAssignmentRequest(view, view.candidates[0], "browser_device1", "nonce5"),
    /not compatible/,
  );
});

test("assignment responses remain proposals and require an exact browser reload artifact", () => {
  const view = parseReleaseControlView(fixture());
  const response = parseAssignmentMutationResponse({
    assignment_receipt: view.effective_assignment,
    effective_assignment: view.effective_assignment,
    platform_action: {
      kind: "browser_binary_reload_required",
      artifact: view.candidates[1].artifact,
    },
    install_confirmed: false,
  });
  assert.equal(response.platform_action.artifact.sha256, previewDigest);
  assert.equal(response.install_confirmed, false);

  assert.throws(() => parseAssignmentMutationResponse({
    assignment_receipt: view.effective_assignment,
    effective_assignment: view.effective_assignment,
    platform_action: { kind: "browser_binary_reload_required" },
    install_confirmed: false,
  }), /artifact/);

  assert.throws(() => parseAssignmentMutationResponse({
    assignment_receipt: view.effective_assignment,
    effective_assignment: view.effective_assignment,
    platform_action: { kind: "none" },
    install_confirmed: true,
  }), /must be false/);
});
