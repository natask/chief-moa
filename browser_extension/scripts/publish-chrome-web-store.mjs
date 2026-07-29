// Upload and submit one already-verified extension archive through the
// official Chrome Web Store API v2. Authentication is deliberately external:
// CI mints a short-lived access token and this process never logs it.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const packagePath = resolve(args.get("--package") || "");
const expectedVersion = args.get("--version") || "";
const evidencePath = resolve(args.get("--evidence") || "dist/chrome-web-store-status.json");
const publisherId = process.env.CWS_PUBLISHER_ID || "";
const extensionId = process.env.CWS_EXTENSION_ID || "";
const accessToken = process.env.CWS_ACCESS_TOKEN || "";

function fail(message) {
  throw new Error(message);
}

if (!packagePath || !existsSync(packagePath)) fail("extension package does not exist");
if (!/^\d+(?:\.\d+){0,3}$/.test(expectedVersion)) fail("expected extension version is invalid");
if (!/^[A-Za-z0-9_-]{1,128}$/.test(publisherId)) fail("CWS publisher id is missing or invalid");
if (!/^[a-p]{32}$/.test(extensionId)) fail("CWS extension id is missing or invalid");
if (!accessToken) fail("CWS access token is missing");

const packageBytes = readFileSync(packagePath);
const packageSha256 = createHash("sha256").update(packageBytes).digest("hex");
const packageSize = packageBytes.byteLength;
const expectedGitSha = process.env.GITHUB_SHA || "";
const expectedSourceTreeSha = process.env.EXTENSION_SOURCE_TREE_SHA || "";
let preflightEvidence;
try {
  preflightEvidence = JSON.parse(readFileSync(evidencePath, "utf8"));
} catch {
  fail("preflight release evidence is missing or invalid");
}
if (preflightEvidence?.schema_version !== "chrome-web-store-release-evidence/v1") {
  fail("preflight release evidence schema is invalid");
}
if (!/^[0-9a-f]{40}$/.test(expectedGitSha)
    || preflightEvidence.git_sha !== expectedGitSha) {
  fail("preflight release evidence does not match the exact workflow commit");
}
if (!/^[0-9a-f]{40}$/.test(expectedSourceTreeSha)
    || preflightEvidence.source_tree_sha !== expectedSourceTreeSha) {
  fail("preflight release evidence does not match the exact extension source tree");
}
if (preflightEvidence.expected_version !== expectedVersion
    || preflightEvidence.package?.sha256 !== packageSha256
    || preflightEvidence.package?.size_bytes !== packageSize) {
  fail("preflight release evidence does not match the package bytes and version");
}
const itemName = `publishers/${publisherId}/items/${extensionId}`;
const itemPath = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}`;
const apiRoot = "https://chromewebstore.googleapis.com";

const evidence = {
  schema_version: "chrome-web-store-release-evidence/v1",
  extension_id: extensionId,
  expected_version: expectedVersion,
  git_sha: expectedGitSha,
  source_tree_sha: expectedSourceTreeSha,
  package: {
    sha256: packageSha256,
    size_bytes: packageSize,
  },
  upload: null,
  submission: null,
  store_status: null,
};

function safeApiError(payload, status) {
  const apiStatus = typeof payload?.error?.status === "string" ? payload.error.status : "UNKNOWN";
  const rawMessage = typeof payload?.error?.message === "string" ? payload.error.message : "request failed";
  const message = rawMessage.replace(/[\r\n]+/g, " ").slice(0, 500);
  return new Error(`Chrome Web Store API ${status} ${apiStatus}: ${message}`);
}

async function api(path, { method = "GET", body, contentType } = {}) {
  const response = await fetch(`${apiRoot}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
    body,
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Chrome Web Store API ${response.status} returned invalid JSON`);
    }
  }
  if (!response.ok) throw safeApiError(payload, response.status);
  return payload;
}

function boundedRevisionStatus(value) {
  if (!value || typeof value !== "object") return null;
  return {
    state: typeof value.state === "string" ? value.state : null,
    distribution_channels: Array.isArray(value.distributionChannels)
      ? value.distributionChannels.slice(0, 8).map((channel) => ({
          deploy_percentage: Number.isInteger(channel?.deployPercentage) ? channel.deployPercentage : null,
          crx_version: typeof channel?.crxVersion === "string" ? channel.crxVersion : null,
        }))
      : [],
  };
}

function boundedStoreStatus(status) {
  return {
    item_id: typeof status?.itemId === "string" ? status.itemId : extensionId,
    last_async_upload_state: typeof status?.lastAsyncUploadState === "string"
      ? status.lastAsyncUploadState
      : null,
    published_revision: boundedRevisionStatus(status?.publishedItemRevisionStatus),
    submitted_revision: boundedRevisionStatus(status?.submittedItemRevisionStatus),
    taken_down: status?.takenDown === true,
    warned: status?.warned === true,
  };
}

function uploadedVersionFromStatus(status) {
  const revisions = [status?.submittedItemRevisionStatus, status?.publishedItemRevisionStatus];
  for (const revision of revisions) {
    for (const channel of revision?.distributionChannels || []) {
      if (channel?.crxVersion === expectedVersion) return expectedVersion;
    }
  }
  return null;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function fetchStatus() {
  return api(`/v2/${itemPath}:fetchStatus`);
}

async function main() {
  const upload = await api(`/upload/v2/${itemPath}:upload`, {
    method: "POST",
    body: packageBytes,
    contentType: "application/zip",
  });
  evidence.upload = {
    state: typeof upload.uploadState === "string" ? upload.uploadState : null,
    crx_version: typeof upload.crxVersion === "string" ? upload.crxVersion : null,
  };

  let uploadedVersion = evidence.upload.crx_version;
  let status = null;
  const inProgressStates = new Set(["IN_PROGRESS", "UPLOAD_IN_PROGRESS"]);
  if (inProgressStates.has(evidence.upload.state)) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await delay(5000);
      status = await fetchStatus();
      if (!inProgressStates.has(status?.lastAsyncUploadState)) break;
    }
    if (inProgressStates.has(status?.lastAsyncUploadState)) {
      fail("Chrome Web Store upload remained in progress after the polling window");
    }
    if (status?.lastAsyncUploadState && status.lastAsyncUploadState !== "SUCCEEDED") {
      fail(`Chrome Web Store upload finished as ${status.lastAsyncUploadState}`);
    }
    uploadedVersion ||= uploadedVersionFromStatus(status);
  } else if (evidence.upload.state !== "SUCCEEDED") {
    fail(`Chrome Web Store upload finished as ${evidence.upload.state || "unknown"}`);
  }

  if (uploadedVersion !== expectedVersion) {
    fail(`store accepted version ${uploadedVersion || "unknown"}, expected ${expectedVersion}`);
  }

  const submission = await api(`/v2/${itemPath}:publish`, {
    method: "POST",
    body: JSON.stringify({ publishType: "DEFAULT_PUBLISH", blockOnWarnings: true }),
    contentType: "application/json",
  });
  evidence.submission = {
    item_id: typeof submission?.itemId === "string" ? submission.itemId : extensionId,
    state: typeof submission?.state === "string" ? submission.state : null,
    warning_count: Array.isArray(submission?.warningInfo?.warnings)
      ? submission.warningInfo.warnings.length
      : 0,
  };

  status = await fetchStatus();
  evidence.store_status = boundedStoreStatus(status);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });

  console.log(`Chrome Web Store upload verified for ${itemName} version ${expectedVersion}.`);
  console.log(`Submission state: ${evidence.submission.state || "unknown"}.`);
  console.log("Publication is store evidence only; an installed-browser receipt is still required.");
}

main().catch((error) => {
  evidence.failure = String(error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 700);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.error(`Chrome Web Store release failed: ${evidence.failure}`);
  process.exitCode = 1;
});
