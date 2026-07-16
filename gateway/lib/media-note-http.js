"use strict";

const fs = require("node:fs");

function createMediaNoteHttpHandlers(options) {
  const recordCreated = typeof options.recordCreated === "function" ? options.recordCreated : () => {};

  async function create(request, response) {
    let bytes;
    try {
      bytes = await readRawBody(request, options.maxBytes);
    } catch (error) {
      sendJson(response, Number(error?.statusCode) || 400, { error: cleanError(error) });
      return;
    }
    if (!bytes || bytes.length === 0) {
      sendJson(response, 400, { error: `${options.label} body is empty` });
      return;
    }
    let note;
    try {
      note = options.store.create({
        bytes,
        content_type: request.headers["content-type"] || "",
        surface: request.headers["x-moa-surface"] || "",
        session_id: request.headers["x-moa-session-id"] || "",
        duration_ms: request.headers["x-moa-duration-ms"] || "",
        label: request.headers["x-moa-label"] || "",
      });
    } catch (error) {
      sendJson(response, Number(error?.statusCode) || 500, { error: cleanError(error) });
      return;
    }
    try {
      recordCreated(note);
    } catch {}
    sendJson(response, 201, { note });
  }

  function list(response, url) {
    sendJson(response, 200, { notes: options.store.list({ limit: url.searchParams.get("limit") }) });
  }

  function get(response, url) {
    const id = noteId(url.pathname);
    const note = id ? options.store.get(id) : null;
    if (!note) {
      sendJson(response, 404, { error: `${options.label} not found` });
      return;
    }
    sendJson(response, 200, { note });
  }

  function sendBlob(response, url) {
    const id = noteId(url.pathname.replace(new RegExp(`/${options.mediaSegment}$`), ""));
    const note = id ? options.store.get(id) : null;
    if (!note) {
      sendJson(response, 404, { error: `${options.label} not found` });
      return;
    }
    const filePath = options.blobPath(id);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendJson(response, 404, { error: `${options.label} ${options.mediaSegment} not found` });
      return;
    }
    const stat = fs.statSync(filePath);
    response.writeHead(200, {
      "content-type": note.content_type || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": "private, no-store",
      [`x-moa-${options.headerName}-id`]: note.id,
      [`x-moa-${options.headerName}-kind`]: "note",
    });
    fs.createReadStream(filePath).pipe(response);
  }

  function remove(response, url) {
    const id = noteId(url.pathname);
    if (!id || !options.store.remove(id)) {
      sendJson(response, 404, { error: `${options.label} not found` });
      return;
    }
    sendJson(response, 200, { deleted: true, id });
  }

  function noteId(pathname) {
    const rest = String(pathname || "").slice(options.pathPrefix.length);
    if (!rest || rest.includes("/")) return "";
    try {
      return decodeURIComponent(rest).trim();
    } catch {
      return "";
    }
  }

  return {
    create,
    list,
    get,
    sendBlob,
    remove,
  };
}

function readRawBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        const error = new Error("request body too large");
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}

module.exports = { createMediaNoteHttpHandlers };
