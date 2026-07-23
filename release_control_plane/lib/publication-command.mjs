"use strict";

const GIT_SHA = /^[a-f0-9]{40}$/;
const AUTHORITY_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function repositoryAuthorityFromEnvironment(environment, manifest) {
  const authorityId = String(environment.MOA_REPOSITORY_RELEASE_AUTHORITY_ID || "").trim().toLowerCase();
  const gitSha = String(environment.MOA_REPOSITORY_RELEASE_GIT_SHA || "").trim().toLowerCase();
  const sourceRef = String(environment.MOA_REPOSITORY_RELEASE_SOURCE_REF || "").trim();
  const channels = String(environment.MOA_REPOSITORY_RELEASE_CHANNELS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!AUTHORITY_ID.test(authorityId)) throw new Error("trusted repository authority id is missing or invalid");
  if (!GIT_SHA.test(gitSha)) throw new Error("trusted repository Git SHA is missing or invalid");
  if (!sourceRef) throw new Error("trusted repository source ref is missing");
  if (!channels.length || channels.some((channel) => !["preview", "stable"].includes(channel))) {
    throw new Error("trusted repository channels are missing or invalid");
  }
  if (gitSha !== manifest.git_sha) throw new Error("trusted repository Git SHA does not match manifest");
  if (sourceRef !== manifest.source_ref) throw new Error("trusted repository source ref does not match manifest");
  if (!channels.includes(manifest.channel)) throw new Error("trusted repository authority does not allow channel");
  const promotionBundleId = String(environment.MOA_REPOSITORY_RELEASE_PROMOTION_BUNDLE_ID || "").trim().toLowerCase();
  const promotionEvidenceRef = String(environment.MOA_REPOSITORY_RELEASE_PROMOTION_EVIDENCE_REF || "").trim();
  if (manifest.channel === "stable") {
    if (promotionBundleId !== manifest.bundle_id) {
      throw new Error("stable publication promotion bundle does not match manifest");
    }
    if (!promotionEvidenceRef || promotionEvidenceRef.length > 1024) {
      throw new Error("stable publication promotion evidence is required");
    }
  }
  return Object.freeze({
    allowed: true,
    authority_kind: "repository_release",
    authority_id: authorityId,
    authorized_git_sha: gitSha,
    authorized_source_refs: Object.freeze([sourceRef]),
    authorized_channels: Object.freeze([...new Set(channels)]),
    promotion_bundle_id: promotionBundleId || null,
    promotion_evidence_ref: promotionEvidenceRef || null,
  });
}

export function dedicatedReleaseDatabaseUrl(environment) {
  const releaseUrl = String(environment.RELEASE_CONTROL_DATABASE_URL || "").trim();
  if (!releaseUrl) throw new Error("RELEASE_CONTROL_DATABASE_URL is required");
  const gatewayUrl = String(environment.DATABASE_URL || "").trim();
  const parsed = new URL(releaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
    throw new Error("RELEASE_CONTROL_DATABASE_URL is invalid");
  }
  if (gatewayUrl) {
    let gateway;
    try {
      gateway = new URL(gatewayUrl);
    } catch {
      throw new Error("DATABASE_URL is invalid");
    }
    if (databaseIdentity(parsed) === databaseIdentity(gateway)) {
      throw new Error("release control-plane database must be separate from DATABASE_URL");
    }
  }
  return releaseUrl;
}

export function parsePublicationCommand(argv) {
  const [command, manifestPath, confirmation, ...extra] = argv;
  if (extra.length || !["check-manifest", "publish-manifest"].includes(command) || !manifestPath) {
    throw new Error("usage");
  }
  if (command === "publish-manifest" && confirmation !== "--confirm-publish-exact-release") {
    throw new Error("publish-manifest requires --confirm-publish-exact-release");
  }
  if (command === "check-manifest" && confirmation != null) throw new Error("usage");
  return Object.freeze({ command, manifest_path: manifestPath });
}

function databaseIdentity(url) {
  if (!["postgres:", "postgresql:"].includes(url.protocol)) return `unsupported:${url.protocol}`;
  const port = url.port || "5432";
  let database;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    database = url.pathname.replace(/^\/+/, "");
  }
  return `${url.hostname.toLowerCase()}:${port}/${database}`;
}
