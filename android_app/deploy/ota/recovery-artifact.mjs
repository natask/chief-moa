import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const APP_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is required`);
  return value;
}

function string(value, label, pattern) {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid`);
  }
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`);
  return value;
}

function digest(value, label) {
  return string(String(value || "").toLowerCase(), label, SHA256);
}

function commit(value, label) {
  return string(String(value || "").toLowerCase(), label, COMMIT);
}

function binding(value, label) {
  const source = object(value, label);
  return Object.freeze({
    bundle_id: string(source.bundle_id, `${label}.bundle_id`, SAFE_ID),
    release_id: string(source.release_id, `${label}.release_id`, SAFE_ID),
    sequence: integer(source.sequence, `${label}.sequence`),
  });
}

function sameBinding(left, right) {
  return left.bundle_id === right.bundle_id
    && left.release_id === right.release_id
    && left.sequence === right.sequence;
}

function exactRelease(value, label, { channel = false } = {}) {
  const source = object(value, label);
  const result = {
    bundle_id: string(source.bundle_id, `${label}.bundle_id`, SAFE_ID),
    release_id: string(source.release_id, `${label}.release_id`, SAFE_ID),
    source_commit: commit(source.source_commit, `${label}.source_commit`),
    artifact_sha256: digest(source.artifact_sha256, `${label}.artifact_sha256`),
    artifact_version_code: integer(source.artifact_version_code, `${label}.artifact_version_code`, 1),
  };
  if (channel) {
    if (!['stable', 'trial'].includes(source.channel)) fail(`${label}.channel is invalid`);
    result.channel = source.channel;
    result.sequence = integer(source.sequence, `${label}.sequence`);
  }
  return Object.freeze(result);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function provenanceSha256(receipt) {
  const payload = { ...receipt };
  delete payload.provenance_sha256;
  return crypto.createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export function assertSourceCommitAvailable(resolvedCommit, expectedCommit) {
  if (commit(resolvedCommit, "resolved source commit")
    !== commit(expectedCommit, "expected source commit")) {
    fail("exact recovery source commit is unavailable");
  }
}

export function prepareRecovery(input, predecessorFacts, requestedVersionCode, builderCommit) {
  const source = object(input, "request");
  if (source.schema_version !== 1) fail("request.schema_version is invalid");
  const target = exactRelease(source.target_predecessor, "target_predecessor", { channel: true });
  const replaces = exactRelease(source.replaces, "replaces");
  const stable = binding(source.parent_stable, "parent_stable");
  const trial = source.parent_trial == null ? null : binding(source.parent_trial, "parent_trial");
  const targetBinding = {
    bundle_id: target.bundle_id, release_id: target.release_id, sequence: target.sequence,
  };
  // Stable recovery targets the current stable head. Trial undo is different:
  // target is the separately confirmed historical T1 while parent_trial is
  // the current T2 being replaced. Exact target source/APK facts below bind T1;
  // release-history freshness is checked by the gateway before this trusted
  // operator-side build request is issued.
  if (target.channel === "stable" && !sameBinding(targetBinding, stable)) {
    fail("target predecessor binding is stale");
  }
  const replacementBinding = [stable, trial].find((candidate) => candidate
    && candidate.bundle_id === replaces.bundle_id
    && candidate.release_id === replaces.release_id);
  if (!replacementBinding) fail("replaced release binding is stale");
  const facts = object(predecessorFacts, "predecessor artifact facts");
  const appId = string(facts.app_id, "predecessor artifact app_id", APP_ID);
  const signer = digest(facts.signer_sha256, "predecessor artifact signer_sha256");
  if (digest(facts.sha256, "predecessor artifact sha256") !== target.artifact_sha256
    || integer(facts.size_bytes, "predecessor artifact size_bytes", 1) !== source.target_predecessor.artifact_size_bytes
    || integer(facts.version_code, "predecessor artifact version_code", 1) !== target.artifact_version_code
    || appId !== string(source.target_predecessor.app_id, "target_predecessor.app_id", APP_ID)
    || signer !== digest(source.target_predecessor.signer_sha256, "target_predecessor.signer_sha256")) {
    fail("predecessor APK identity does not match target provenance");
  }
  const versionCode = integer(requestedVersionCode, "recovery version_code", 1);
  if (versionCode <= replaces.artifact_version_code || versionCode <= target.artifact_version_code) {
    fail("recovery version_code is not forward-versioned");
  }
  if (versionCode > 2100000000) fail("recovery version_code exceeds Android maximum");
  const sourceCommit = target.source_commit;
  const recoveryReleaseId = `${appId.toLowerCase()}-recovery-${versionCode}-${sourceCommit.slice(0, 12)}`;
  if (!SAFE_ID.test(recoveryReleaseId)) fail("derived recovery_release_id is invalid");
  return Object.freeze({
    recovery_release_id: recoveryReleaseId,
    source_commit: sourceCommit,
    builder_commit: commit(builderCommit, "builder_commit"),
    version_code: versionCode,
    version_name: `0.1.${versionCode}-recovery`,
    app_id: appId,
    signer_sha256: signer,
    target_predecessor: Object.freeze({
      channel: target.channel,
      bundle_id: target.bundle_id,
      release_id: target.release_id,
      sequence: target.sequence,
      artifact_sha256: target.artifact_sha256,
      artifact_version_code: target.artifact_version_code,
    }),
    replaces,
    parent_stable: stable,
    parent_trial: trial,
  });
}

export function finalizeRecovery(plan, builtFacts, builtAt) {
  const facts = object(builtFacts, "built artifact facts");
  const sha256 = digest(facts.sha256, "built artifact sha256");
  const sizeBytes = integer(facts.size_bytes, "built artifact size_bytes", 1);
  if (string(facts.app_id, "built artifact app_id", APP_ID) !== plan.app_id
    || integer(facts.version_code, "built artifact version_code", 1) !== plan.version_code
    || digest(facts.signer_sha256, "built artifact signer_sha256") !== plan.signer_sha256) {
    fail("built recovery APK package, version, or continuity signer is wrong");
  }
  if (!builtAt || Number.isNaN(Date.parse(builtAt))) fail("built_at is invalid");
  const downloadPath = `/v1/release-recovery/artifacts/${plan.recovery_release_id}.apk`;
  const receipt = {
    schema_version: 1,
    kind: "android_forward_recovery",
    recovery_release_id: plan.recovery_release_id,
    source_commit: plan.source_commit,
    builder_commit: plan.builder_commit,
    built_at: builtAt,
    download_path: downloadPath,
    artifact: {
      apk: "moa-assistant.apk",
      app_id: plan.app_id,
      version_code: plan.version_code,
      version_name: plan.version_name,
      sha256,
      size_bytes: sizeBytes,
      signer_sha256: plan.signer_sha256,
    },
    target_predecessor: plan.target_predecessor,
    replaces: plan.replaces,
    parent_stable: plan.parent_stable,
    parent_trial: plan.parent_trial,
  };
  return Object.freeze({ ...receipt, provenance_sha256: provenanceSha256(receipt) });
}

export function installRecoveryArtifact(outDir, apkPath, receipt) {
  const root = path.resolve(outDir);
  const releaseDir = path.join(root, "releases", receipt.recovery_release_id);
  const apkBytes = fs.readFileSync(apkPath);
  if (crypto.createHash("sha256").update(apkBytes).digest("hex") !== receipt.artifact.sha256
    || apkBytes.length !== receipt.artifact.size_bytes) fail("built APK bytes changed before publication");
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (fs.existsSync(releaseDir)) {
    const oldApk = fs.readFileSync(path.join(releaseDir, "moa-assistant.apk"));
    const oldReceipt = fs.readFileSync(path.join(releaseDir, "recovery.json"), "utf8");
    if (!oldApk.equals(apkBytes) || oldReceipt !== serialized) fail("immutable recovery release collision");
    return releaseDir;
  }
  fs.mkdirSync(path.join(root, "releases"), { recursive: true });
  const stage = fs.mkdtempSync(path.join(root, ".recovery-stage-"));
  try {
    fs.writeFileSync(path.join(stage, "moa-assistant.apk"), apkBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(stage, "recovery.json"), serialized, { mode: 0o600 });
    fs.renameSync(stage, releaseDir);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return releaseDir;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "prepare" && args.length === 5) {
    const [requestFile, factsFile, versionCode, builderCommit, outputFile] = args;
    const plan = prepareRecovery(
      JSON.parse(fs.readFileSync(requestFile, "utf8")),
      JSON.parse(fs.readFileSync(factsFile, "utf8")),
      Number(versionCode), builderCommit,
    );
    fs.writeFileSync(outputFile, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return;
  }
  if (command === "finalize" && args.length === 5) {
    const [planFile, factsFile, apkPath, outDir, builtAt] = args;
    const receipt = finalizeRecovery(
      JSON.parse(fs.readFileSync(planFile, "utf8")),
      JSON.parse(fs.readFileSync(factsFile, "utf8")), builtAt,
    );
    const releaseDir = installRecoveryArtifact(outDir, apkPath, receipt);
    process.stdout.write(`${releaseDir}\n`);
    return;
  }
  fail("usage: recovery-artifact.mjs prepare REQUEST FACTS VERSION BUILDER OUT | finalize PLAN FACTS APK OUT_DIR BUILT_AT");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
