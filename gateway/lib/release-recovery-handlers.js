"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const {
  ForwardRecoveryError,
  projectForwardRecoveryManifest,
  recoveryExpectationFromView,
} = require("./forward-recovery-manifest");

const MANIFEST_PATH = "/v1/release-recovery/manifest";
const ARTIFACT_PATTERN = /^\/v1\/release-recovery\/artifacts\/([^/]+)\.apk$/;
const FORGED_IDENTITY_KEYS = new Set([
  "application_id", "tenant_id", "owner_id", "user_id", "device_id",
  "surface", "surface_id", "scope_id", "scope_type",
]);

function createReleaseRecoveryHandlers(options = {}) {
  const recoveryView = requiredFunction(options.recoveryView, "recoveryView");
  const resolveArtifactPath = requiredFunction(options.resolveArtifactPath, "resolveArtifactPath");
  const sendJson = requiredFunction(options.sendJson, "sendJson");
  const externalOriginForRequest = requiredFunction(
    options.externalOriginForRequest,
    "externalOriginForRequest",
  );
  const recoveryStore = options.recoveryStore || null;

  async function routeReleaseRecovery(request, response, url) {
    const pathname = String(url?.pathname || "");
    const artifactMatch = pathname.match(ARTIFACT_PATTERN);
    if (pathname !== MANIFEST_PATH && !artifactMatch) return false;
    if (String(request.method || "GET").toUpperCase() !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    if ([...(url?.searchParams?.keys?.() || [])].some((key) => FORGED_IDENTITY_KEYS.has(key))) {
      sendJson(response, 403, { error: "release_recovery_identity_forbidden" });
      return true;
    }
    if (url?.search) {
      sendJson(response, 400, { error: "release_recovery_query_not_supported" });
      return true;
    }

    const result = await recoveryView(request);
    if (!result || result.status !== 200) {
      sendJson(response, result?.status || 401, result?.body || { error: "unauthorized" });
      return true;
    }
    const origin = externalOriginForRequest(request);
    const manifest = await recoveryManifestWithForwardRecoveries(
      result.body,
      origin,
      recoveryStore,
    );
    if (!artifactMatch) {
      sendJson(response, 200, manifest);
      return true;
    }

    const releaseId = safeDecode(artifactMatch[1]);
    const artifact = allowedArtifacts(manifest).find((item) => item.release_id === releaseId);
    if (!artifact) {
      sendJson(response, 404, { error: "release_recovery_artifact_not_found" });
      return true;
    }
    const apkPath = artifact.kind === "forward_recovery"
      ? recoveryStore?.artifactPath(releaseId)
      : resolveArtifactPath(releaseId);
    const verified = await verifyArtifact(apkPath, artifact);
    if (!verified) {
      sendJson(response, 404, { error: "release_recovery_artifact_not_found" });
      return true;
    }
    const stat = fs.statSync(apkPath);
    response.writeHead(200, {
      "content-type": "application/vnd.android.package-archive",
      "content-length": stat.size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    fs.createReadStream(apkPath).pipe(response);
    return true;
  }

  return Object.freeze({ routeReleaseRecovery });
}

function recoveryManifest(view, origin) {
  const stable = recoveryCandidate(view, "stable");
  const trial = view?.effective_assignment?.channel === "preview"
    ? recoveryCandidate(view, "preview", view.effective_assignment.bundle_id)
    : null;
  const compatible = [stable, trial].filter(Boolean);
  const installed = installedCandidate(view?.installed, compatible);
  const candidates = compatible.map((item) => withRecoveryUrl(item, origin));
  return Object.freeze({
    schema_version: 1,
    application_id: String(view?.application_id || ""),
    device_id: String(view?.device_id || ""),
    channels: Object.freeze({
      stable: channelHead(candidates.find((item) => item.channel === "stable")),
      preview: channelHead(candidates.find((item) => item.channel === "preview")),
    }),
    candidates: Object.freeze(candidates),
    installed,
  });
}

async function recoveryManifestWithForwardRecoveries(view, origin, store) {
  const base = recoveryManifest(view, origin);
  if (!store) return Object.freeze({
    ...base,
    recoveries: Object.freeze([]),
    recommended_recovery_id: null,
  });
  const entries = [];
  for (const receipt of await store.listReceipts()) {
    try {
      const expected = recoveryExpectationFromView(receipt, view);
      entries.push(await projectForwardRecoveryManifest({
        receipt,
        expected,
        application_id: view.application_id,
        device_id: view.device_id,
        download_url: `${String(origin || "").replace(/\/$/, "")}${receipt.download_path}`,
        inspectArtifact: store.inspectArtifact,
      }));
    } catch (error) {
      if (!(error instanceof ForwardRecoveryError)) throw error;
    }
  }
  entries.sort((left, right) => (
    right.artifact.version_code - left.artifact.version_code
      || right.artifact.built_at.localeCompare(left.artifact.built_at)
      || left.recovery_id.localeCompare(right.recovery_id)
  ));
  return Object.freeze({
    ...base,
    recoveries: Object.freeze(entries),
    recommended_recovery_id: entries[0]?.recovery_id || null,
  });
}

function recoveryCandidate(view, channel, bundleId = "") {
  const candidate = (Array.isArray(view?.candidates) ? view.candidates : []).find((item) => (
    item?.channel === channel
      && (!bundleId || item.bundle_id === bundleId)
      && item.compatibility?.eligible === true
      && item.readiness?.ready === true
      && item.artifact?.surface === "android"
  ));
  if (!candidate) return null;
  return publicRecoveryArtifact(candidate, candidate.artifact);
}

function installedCandidate(installed, candidates) {
  if (!installed?.release_id || installed.surface !== "android") return null;
  const candidate = candidates.find((item) => item.release_id === installed.release_id
    && item.artifact.sha256 === installed.artifact_sha256);
  return candidate ? Object.freeze({
    surface: "android",
    release_id: candidate.release_id,
    artifact_sha256: candidate.artifact.sha256,
    app_id: candidate.artifact.app_id,
    version_code: candidate.artifact.version_code,
    version_name: candidate.artifact.version_name,
    status: installed.status || "installed",
  }) : null;
}

function publicRecoveryArtifact(candidate, artifact) {
  return Object.freeze({
    channel: candidate.channel,
    sequence: candidate.sequence || 0,
    bundle_id: String(candidate.bundle_id || ""),
    release_id: String(candidate.release_id || ""),
    source_ref: String(artifact.git_sha || ""),
    compatibility: Object.freeze({ eligible: true, reasons: Object.freeze([]) }),
    readiness: Object.freeze({ status: "published", ready: true }),
    artifact: Object.freeze({
      surface: "android",
      app_id: String(artifact.app_id || "ag.companion"),
      version_code: artifact.version_code,
      version_name: artifact.version_name || artifact.version,
      sha256: String(artifact.sha256 || "").toLowerCase(),
      size_bytes: artifact.size_bytes,
      git_sha: String(artifact.git_sha || ""),
    }),
  });
}

function withRecoveryUrl(value, origin) {
  if (!value) return null;
  return Object.freeze({
    ...value,
    artifact: Object.freeze({
      ...value.artifact,
      download_url: `${String(origin || "").replace(/\/$/, "")}/v1/release-recovery/artifacts/${encodeURIComponent(value.release_id)}.apk`,
    }),
  });
}

function allowedArtifacts(manifest) {
  const ordinary = (Array.isArray(manifest.candidates) ? manifest.candidates : []).map((item) => ({
    release_id: item.release_id,
    sha256: item.artifact.sha256,
    size_bytes: item.artifact.size_bytes,
    kind: "candidate",
  }));
  const recoveries = (Array.isArray(manifest.recoveries) ? manifest.recoveries : []).map((item) => ({
    release_id: item.recovery_id,
    sha256: item.artifact.sha256,
    size_bytes: item.artifact.size_bytes,
    kind: "forward_recovery",
  }));
  return [...ordinary, ...recoveries];
}

function channelHead(candidate) {
  return candidate ? Object.freeze({
    sequence: candidate.sequence || 0,
    bundle: Object.freeze({ bundle_id: candidate.bundle_id, release_id: candidate.release_id }),
  }) : null;
}

async function verifyArtifact(file, expected) {
  if (!file || !fs.existsSync(file)) return false;
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size !== expected.size_bytes) return false;
  const digest = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex") === expected.sha256;
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}

module.exports = {
  createReleaseRecoveryHandlers,
  recoveryManifest,
  recoveryManifestWithForwardRecoveries,
  verifyArtifact,
};
