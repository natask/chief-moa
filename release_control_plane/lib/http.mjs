"use strict";

// Framework-neutral transport boundary. Authentication is injected so caller
// JSON can never choose its tenant or actor. The service remains the authority
// check and persistence boundary.
export function createReleaseControlHttpHandler(service, { authenticate } = {}) {
  if (!service) throw new Error("service is required");
  if (typeof authenticate !== "function") throw new Error("authenticate(request) is required");

  return async function handle(request = {}) {
    try {
      const principal = await authenticate(request);
      if (!principal?.tenant_id || !principal?.actor_id || !principal?.owner_id
          || !principal?.device_id || !principal?.surface_id) {
        return response(401, { error: "unauthorized" });
      }
      const method = String(request.method || "GET").toUpperCase();
      const match = String(request.path || "").match(/^\/v1\/release-control\/apps\/([^/]+)\/(view|candidates|candidate-selections|assignments|fallback|install-receipts|feedback)$/);
      if (!match) return response(404, { error: "not_found" });
      const applicationId = decodeURIComponent(match[1]);
      const action = match[2];
      const caller = method === "GET" ? request.query : request.body;
      const trustedSurface = principal.surface_id;
      const trustedUser = principal.user_id || principal.owner_id;
      assertTrustedCallerScope(caller, {
        tenant_id: principal.tenant_id,
        actor_id: principal.actor_id,
        owner_id: trustedUser,
        user_id: trustedUser,
        device_id: principal.device_id,
        surface: trustedSurface,
        surface_id: trustedSurface,
        application_id: applicationId,
        scope_type: "device",
        scope_id: principal.device_id,
      });
      const input = {
        ...(caller || {}),
        tenant_id: principal.tenant_id,
        actor_id: principal.actor_id,
        owner_id: trustedUser,
        user_id: trustedUser,
        device_id: principal.device_id,
        application_id: applicationId,
        surface: trustedSurface,
        surface_id: trustedSurface,
        authority: {
          actor_id: principal.actor_id,
          owner_id: principal.owner_id,
          role_bindings: principal.role_bindings || [],
          delegation_grants: principal.delegation_grants || [],
          now_ms: principal.now_ms,
        },
      };
      if (input.expected_sequence == null && input.expected_assignment_sequence != null) {
        input.expected_sequence = input.expected_assignment_sequence;
      }
      if (input.assignment_event_id == null && input.assignment_id != null) {
        input.assignment_event_id = input.assignment_id;
      }
      if (input.surface_id == null && input.surface != null) input.surface_id = input.surface;
      if (input.artifact_sha256 == null && input.sha256 != null) input.artifact_sha256 = input.sha256;

      if (method === "GET" && action === "view") {
        return response(200, (await releaseViewProjection(service, input)).body);
      }
      if (method === "GET" && action === "candidates") {
        return response(200, publicCatalog(await service.listCandidates(input), trustedSurface));
      }
      if (method === "POST" && action === "candidate-selections") {
        const assignment = await service.selectCandidate(input);
        return response(201, await assignmentEnvelope(service, input, assignment));
      }
      if (method === "POST" && action === "assignments") {
        const assignment = await service.assign(input);
        return response(201, await assignmentEnvelope(service, input, assignment));
      }
      if (method === "POST" && action === "fallback") {
        const assignment = await service.fallback(input);
        return response(201, await assignmentEnvelope(service, input, assignment));
      }
      if (method === "POST" && action === "install-receipts") {
        return response(201, { install_receipt: publicInstallReceipt(await service.recordInstallReceipt(input)) });
      }
      if (method === "POST" && action === "feedback") {
        return response(201, { feedback: publicFeedback(await service.recordFeedback(input)) });
      }
      return response(405, { error: "method_not_allowed" });
    } catch (error) {
      if (error?.code === "release_not_authorized") return response(403, { error: error.code });
      if (error?.code === "assignment_sequence_conflict") {
        return response(409, {
          error: error.code,
          expected_assignment_sequence: error.expected_sequence,
          actual_assignment_sequence: error.actual_sequence,
        });
      }
      if (error?.code === "release_binding_mismatch") {
        return response(409, { error: error.code, reason: error.reason });
      }
      return response(400, { error: "invalid_request", message: String(error?.message || error).slice(0, 500) });
    }
  };
}

function assertTrustedCallerScope(caller, trusted) {
  if (!caller || typeof caller !== "object") return;
  for (const [field, expected] of Object.entries(trusted)) {
    if (!Object.prototype.hasOwnProperty.call(caller, field)) continue;
    if (canonicalIdentity(caller[field]) !== canonicalIdentity(expected)) {
      const error = new Error("caller identity does not match authenticated principal");
      error.code = "release_not_authorized";
      throw error;
    }
  }
  if (Object.prototype.hasOwnProperty.call(caller, "cohort_id")) {
    const error = new Error("caller scope does not match authenticated principal");
    error.code = "release_not_authorized";
    throw error;
  }
}

function canonicalIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function publicCatalog(catalog, surface) {
  return {
    schema_version: 1,
    candidates: catalog.items.map((bundle) => {
      const artifact = bundle.artifacts.find((item) => item.surface_id === surface) || null;
      return {
        bundle_id: bundle.bundle_id,
        compatibility_version: bundle.compatibility_version,
        created_at: bundle.created_at,
        lineage: bundle.lineage,
        release_id: artifact?.release_id || null,
        artifact: artifact ? publicArtifact(artifact) : null,
      };
    }),
    next_cursor: catalog.next_cursor,
  };
}

async function assignmentEnvelope(service, input, assignment) {
  const projection = await releaseViewProjection(service, input);
  const candidate = projection.effectiveCandidate?.bundle_id === assignment.bundle_id
    ? projection.effectiveCandidate : null;
  return {
    assignment_receipt: publicAssignment(assignment, candidate?.release_id || null),
    effective_assignment: projection.body.effective_assignment,
    platform_action: platformAction(projection.surface, candidate?.artifact || null),
    install_confirmed: false,
  };
}

async function releaseViewProjection(service, input) {
  const surface = String(input.surface || input.surface_id || "").trim();
  const view = await service.view(input);
  const effectiveBundle = await resolveAssignedBundle(service, input, view, view.effective_assignment?.bundle_id);
  const fallbackBundle = await resolveAssignedBundle(
    service,
    input,
    view,
    view.effective_assignment?.stable_fallback_bundle_id,
  );
  const effectiveCandidate = bundleCandidate(
    effectiveBundle,
    view.effective_assignment?.channel || "candidate",
    surface,
  );
  const fallbackCandidate = bundleCandidate(fallbackBundle, "stable", surface);
  return {
    body: publicView(view, surface, { effectiveCandidate, fallbackCandidate }),
    effectiveCandidate,
    fallbackCandidate,
    surface,
  };
}

async function resolveAssignedBundle(service, input, view, bundleId) {
  if (!bundleId) return null;
  const frame = view.channels.find((item) => item.bundle?.bundle_id === bundleId);
  if (frame?.bundle) return frame.bundle;
  let cursor = null;
  const visited = new Set();
  do {
    const page = await service.listCandidates({ ...input, limit: 100, cursor });
    const exact = page.items.find((item) => item.bundle_id === bundleId);
    if (exact) return exact;
    cursor = page.next_cursor;
    if (cursor && visited.has(cursor)) throw new Error("candidate catalog cursor repeated");
    if (cursor) visited.add(cursor);
  } while (cursor);
  return null;
}

function bundleCandidate(bundle, channel, requestedSurface) {
  if (!bundle) return null;
  const artifact = bundle.artifacts.find((item) => !requestedSurface || item.surface_id === requestedSurface)
    || bundle.artifacts[0];
  if (!artifact) return null;
  const compatible = bundle.compatibility_version === 1;
  return {
    channel,
    sequence: 0,
    bundle_id: bundle.bundle_id,
    compatibility_version: bundle.compatibility_version,
    release_id: artifact.release_id,
    source_ref: artifact.git_sha,
    compatibility: {
      eligible: compatible,
      reasons: compatible ? [] : [`unsupported compatibility version ${bundle.compatibility_version}`],
    },
    readiness: {
      status: compatible && artifact.download_url ? "published" : "blocked",
      ready: compatible && Boolean(artifact.download_url),
    },
    artifact: publicArtifact(artifact),
  };
}

function publicView(view, requestedSurface = "", resolved = {}) {
  const frames = Object.fromEntries(view.channels.map((frame) => [frame.channel, frame]));
  const candidates = [];
  for (const frame of view.channels) {
    for (const artifact of frame.bundle?.artifacts || []) {
      if (requestedSurface && artifact.surface_id !== requestedSurface) continue;
      const compatible = frame.bundle.compatibility_version === 1;
      candidates.push({
        channel: frame.channel,
        sequence: frame.head?.sequence || 0,
        bundle_id: frame.bundle.bundle_id,
        compatibility_version: frame.bundle.compatibility_version,
        release_id: artifact.release_id,
        source_ref: artifact.git_sha,
        compatibility: {
          eligible: compatible,
          reasons: compatible ? [] : [`unsupported compatibility version ${frame.bundle.compatibility_version}`],
        },
        readiness: {
          status: compatible && artifact.download_url ? "published" : "blocked",
          ready: compatible && Boolean(artifact.download_url),
        },
        artifact: publicArtifact(artifact),
      });
    }
  }
  const effectiveCandidate = candidates.find((item) => item.bundle_id === view.effective_assignment?.bundle_id)
    || resolved.effectiveCandidate || null;
  const installedState = view.installation.find((item) => item.surface_id === requestedSurface)
    || view.installation[0] || null;
  const stableCandidate = candidates.find((item) => item.channel === "stable") || null;
  const fallbackCandidate = candidates.find((item) => item.bundle_id === view.effective_assignment?.stable_fallback_bundle_id)
    || resolved.fallbackCandidate || null;
  return {
    schema_version: 1,
    tenant_id: view.tenant_id,
    application_id: view.application_id,
    device_id: view.device_id,
    channels: {
      stable: publicChannel(frames.stable, requestedSurface),
      preview: publicChannel(frames.preview, requestedSurface),
    },
    candidates,
    effective_assignment: publicAssignment(
      view.effective_assignment,
      effectiveCandidate?.release_id || null,
    ),
    installation: view.installation
      .filter((item) => !requestedSurface || item.surface_id === requestedSurface)
      .map((item) => ({
      surface: item.surface_id,
      release_id: item.release_id,
      sha256: item.artifact_sha256,
      assigned: item.assigned,
      installed: item.installed,
      activated: item.activated,
      smoked: item.smoked,
      })),
    feedback_count: view.feedback_count,
    installed: publicInstalled(effectiveCandidate || stableCandidate, installedState),
    last_known_good: view.effective_assignment && fallbackCandidate ? {
      assignment_id: view.effective_assignment.event_id,
      bundle_id: view.effective_assignment.stable_fallback_bundle_id,
      release_id: fallbackCandidate.release_id,
    } : null,
  };
}

function publicChannel(frame, requestedSurface) {
  if (!frame?.head || !frame.bundle) return null;
  const artifact = frame.bundle.artifacts.find((item) => !requestedSurface || item.surface_id === requestedSurface)
    || frame.bundle.artifacts[0];
  return {
    sequence: frame.head.sequence,
    bundle: {
      bundle_id: frame.bundle.bundle_id,
      release_id: artifact.release_id,
      compatibility_version: frame.bundle.compatibility_version,
      created_at: frame.bundle.created_at,
    },
  };
}

function publicArtifact(artifact) {
  return {
    surface: artifact.surface_id,
    sha256: artifact.artifact_sha256,
    size_bytes: artifact.artifact_size,
    download_url: artifact.download_url,
    app_id: artifact.app_id,
    version_code: artifact.version_code,
    version_name: artifact.version_name || artifact.semantic_version,
    version: artifact.semantic_version,
    git_sha: artifact.git_sha,
  };
}

function publicAssignment(assignment, releaseId = null) {
  if (!assignment) return null;
  return {
    assignment_id: assignment.event_id,
    tenant_id: assignment.tenant_id,
    application_id: assignment.application_id,
    scope_type: assignment.scope_type,
    scope: assignment.scope_type,
    scope_id: assignment.scope_id,
    sequence: assignment.sequence,
    channel: assignment.channel,
    bundle_id: assignment.bundle_id,
    release_id: releaseId,
    feature_profile_id: null,
    stable_fallback_bundle_id: assignment.stable_fallback_bundle_id,
    operation: assignment.operation,
    actor_id: assignment.actor_id,
    created_at: assignment.created_at,
    source: assignment.source || assignment.scope_type,
    install_confirmed: false,
  };
}

function publicInstalled(candidate, state) {
  if (!candidate || !state || (!state.installed && !state.activated && !state.smoked)) return null;
  const status = state?.smoked ? "smoked"
    : state?.activated ? "activated"
      : state?.installed ? "installed"
        : "unknown";
  return {
    surface: candidate.artifact.surface,
    release_id: candidate.release_id,
    artifact_sha256: candidate.artifact.sha256,
    app_id: candidate.artifact.app_id,
    version_code: candidate.artifact.version_code,
    version_name: candidate.artifact.version_name,
    version: candidate.artifact.version,
    git_sha: candidate.artifact.git_sha,
    status,
  };
}

function publicInstallReceipt(receipt) {
  return {
    ...receipt,
    assignment_id: receipt.assignment_event_id,
    surface: receipt.surface_id,
    sha256: receipt.artifact_sha256,
  };
}

function publicFeedback(feedback) {
  return {
    ...feedback,
    assignment_id: feedback.assignment_event_id,
    surface: feedback.surface_id,
    sha256: feedback.artifact_sha256,
  };
}

function platformAction(surface, artifact) {
  if (!artifact) return { kind: "none" };
  if (surface === "android") return { kind: "android_install_review", artifact };
  if (surface === "browser_extension") return { kind: "browser_binary_reload_required", artifact };
  return { kind: "none", artifact };
}

function response(status, body) {
  return { status, headers: { "content-type": "application/json" }, body };
}
