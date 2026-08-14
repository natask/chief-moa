"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_RECEIPTS = 100;
const MAX_RECEIPT_BYTES = 64 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,199}$/;

function createFileForwardRecoveryStore(options = {}) {
  const root = path.resolve(String(options.root || ""));
  if (!options.root) throw new Error("forward recovery store root is required");
  const releasesDir = path.join(root, "releases");

  async function listReceipts() {
    let entries;
    try { entries = await fs.promises.readdir(releasesDir, { withFileTypes: true }); }
    catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const receipts = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (receipts.length >= MAX_RECEIPTS || !entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const receiptPath = path.join(releasesDir, entry.name, "recovery.json");
      try {
        const stat = await fs.promises.lstat(receiptPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) continue;
        const receipt = JSON.parse(await fs.promises.readFile(receiptPath, "utf8"));
        if (receipt?.recovery_release_id !== entry.name) continue;
        receipts.push(receipt);
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
    }
    return receipts;
  }

  async function inspectArtifact(receipt) {
    const file = artifactPath(receipt?.recovery_release_id);
    if (!file) return { available: false };
    let stat;
    try { stat = await fs.promises.lstat(file); } catch (error) {
      if (error.code === "ENOENT") return { available: false };
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== receipt?.artifact?.size_bytes) {
      return { available: false };
    }
    const sha256 = await digestFile(file);
    if (sha256 !== receipt?.artifact?.sha256) return { available: false };
    return Object.freeze({
      available: true,
      sha256,
      size_bytes: stat.size,
      app_id: receipt.artifact.app_id,
      version_code: receipt.artifact.version_code,
      signer_sha256: receipt.artifact.signer_sha256,
    });
  }

  function artifactPath(recoveryId) {
    const id = String(recoveryId || "");
    if (!SAFE_ID.test(id)) return "";
    return path.join(releasesDir, id, "moa-assistant.apk");
  }

  return Object.freeze({ listReceipts, inspectArtifact, artifactPath });
}

async function digestFile(file) {
  const digest = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

module.exports = { createFileForwardRecoveryStore };
