"use strict";

// Client-side-encrypted browser-history batches. Devices upload opaque
// iv||ciphertext blobs; the gateway stores the bytes plus a plaintext
// manifest of batch metadata and never sees decrypted history.
//
// Blob bytes go through the blob store (history-archive/<deviceId>/<batchId>.bin
// under DATA_DIR, write-behind-uploaded when BLOB_STORE=gcs). The manifest is
// plain local JSON at DATA_DIR/history-archive/<deviceId>/manifest.json,
// written atomically, same as the audio-notes metadata convention.

const fs = require("node:fs");
const path = require("node:path");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DEFAULT_MAX_BLOB_BYTES = 8 * 1024 * 1024;
// server.js readJsonBody caps bodies at 1 MB; an 8 MB blob is ~11 MB of
// base64, so this route owns its own bounded JSON body reader.
const MAX_BODY_BYTES = 12 * 1024 * 1024;

function createHistoryArchiveHandlers(deps) {
  const { authorized, sendJson, blobStore } = deps;
  const maxBlobBytes = Number(deps.maxBlobBytes) > 0 ? Number(deps.maxBlobBytes) : DEFAULT_MAX_BLOB_BYTES;
  const readBody = deps.readBody || ((request) => readBoundedJsonBody(request, MAX_BODY_BYTES));
  const archiveDir = path.join(path.resolve(deps.dataDir || "./data"), "history-archive");

  async function routeHistoryArchive(request, response, url) {
    const collection = url.pathname === "/v1/history/batches";
    const itemId = batchIdFromPath(url.pathname);
    const recognized = (collection && ["GET", "POST"].includes(request.method))
      || (itemId !== null && request.method === "GET");
    if (!recognized) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    if (typeof response.setHeader === "function") response.setHeader("cache-control", "no-store");
    if (collection && request.method === "POST") await storeBatch(request, response);
    else if (collection) listBatches(response, url);
    else await readBatch(response, itemId, url);
    return true;
  }

  async function storeBatch(request, response) {
    let body;
    try { body = await readBody(request); }
    catch (error) {
      sendJson(response, Number(error?.statusCode) === 413 ? 413 : 400, { error: cleanError(error) });
      return;
    }
    const problem = batchBodyProblem(body);
    if (problem) { sendJson(response, 400, { error: problem }); return; }
    const bytes = Buffer.from(body.blob, "base64");
    if (bytes.length > maxBlobBytes) {
      sendJson(response, 413, { error: `history batch blob exceeds ${maxBlobBytes} bytes` });
      return;
    }
    const entries = readManifest(body.deviceId);
    const alreadyExisted = entries.some((entry) => entry.batchId === body.batchId);
    try {
      await blobStore.put(`history-archive/${body.deviceId}/${body.batchId}.bin`, bytes, {
        contentType: "application/octet-stream",
      });
      writeManifest(body.deviceId, upsertEntry(entries, {
        batchId: body.batchId,
        createdAt: body.createdAt,
        count: body.count,
        bytes: bytes.length,
        minRecordedAt: body.minRecordedAt,
        maxRecordedAt: body.maxRecordedAt,
      }));
    } catch {
      sendJson(response, 500, { error: "history batch storage unavailable" });
      return;
    }
    if (alreadyExisted) sendJson(response, 200, { batchId: body.batchId, stored: true, alreadyExisted: true });
    else sendJson(response, 201, { batchId: body.batchId, stored: true });
  }

  function listBatches(response, url) {
    const device = url.searchParams.get("device") || "";
    if (device && !ID_PATTERN.test(device)) {
      sendJson(response, 400, { error: "device must match [A-Za-z0-9_-]{1,80}" });
      return;
    }
    const sinceRaw = url.searchParams.get("since");
    let since = null;
    if (sinceRaw !== null && sinceRaw !== "") {
      since = Number(sinceRaw);
      if (!Number.isFinite(since)) {
        sendJson(response, 400, { error: "since must be a unix-milliseconds number" });
        return;
      }
    }
    const batches = (device ? [device] : listDeviceIds())
      .flatMap((deviceId) => readManifest(deviceId).map((entry) => ({ deviceId, ...entry })))
      .filter((entry) => since === null || Number(entry.createdAt) > since)
      .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
    sendJson(response, 200, { batches });
  }

  async function readBatch(response, batchId, url) {
    if (!ID_PATTERN.test(batchId)) { sendJson(response, 400, { error: "invalid history batch id" }); return; }
    const device = url.searchParams.get("device") || "";
    if (!ID_PATTERN.test(device)) {
      sendJson(response, 400, { error: "a valid device query parameter is required" });
      return;
    }
    let bytes;
    try { bytes = await blobStore.readBytes(`history-archive/${device}/${batchId}.bin`); }
    catch { sendJson(response, 500, { error: "history batch storage unavailable" }); return; }
    if (!bytes || bytes.length === 0) { sendJson(response, 404, { error: "history batch not found" }); return; }
    sendJson(response, 200, { batchId, deviceId: device, blob: Buffer.from(bytes).toString("base64") });
  }

  function manifestPath(deviceId) {
    return path.join(archiveDir, deviceId, "manifest.json");
  }

  function readManifest(deviceId) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath(deviceId), "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeManifest(deviceId, entries) {
    const filePath = manifestPath(deviceId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  function listDeviceIds() {
    let entries;
    try { entries = fs.readdirSync(archiveDir, { withFileTypes: true }); }
    catch { return []; }
    return entries
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  return Object.freeze({ routeHistoryArchive });
}

function batchBodyProblem(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "request body must be a JSON object";
  if (!ID_PATTERN.test(String(body.batchId || ""))) return "batchId must match [A-Za-z0-9_-]{1,80}";
  if (!ID_PATTERN.test(String(body.deviceId || ""))) return "deviceId must match [A-Za-z0-9_-]{1,80}";
  for (const field of ["createdAt", "count", "minRecordedAt", "maxRecordedAt"]) {
    const value = body[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return `${field} must be a finite positive number`;
    }
  }
  if (!Number.isInteger(body.count)) return "count must be a positive integer";
  if (typeof body.blob !== "string" || body.blob.length === 0 || !BASE64_PATTERN.test(body.blob)) {
    return "blob must be non-empty base64";
  }
  return "";
}

function upsertEntry(entries, entry) {
  const index = entries.findIndex((existing) => existing.batchId === entry.batchId);
  if (index === -1) return [...entries, entry];
  const next = [...entries];
  next[index] = entry;
  return next;
}

function batchIdFromPath(pathname) {
  const prefix = "/v1/history/batches/";
  if (!String(pathname || "").startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  return rest && !rest.includes("/") ? rest : null;
}

function readBoundedJsonBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("request body must be valid JSON")); }
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}

module.exports = { createHistoryArchiveHandlers, batchIdFromPath, batchBodyProblem };
