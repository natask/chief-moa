"use strict";

const { createMediaNoteStore } = require("./media-note-store");
const { createMediaNoteHttpHandlers } = require("./media-note-http");

const DEFAULT_CONTENT_TYPE = "video/webm";
const DEFAULT_MAX_NOTE_BYTES = 24 * 1024 * 1024;

function createVideoNotesStore(options = {}) {
  const store = createMediaNoteStore({
    dataDir: options.dataDir,
    maxTotalBytes: options.maxTotalBytes,
    directory: "video-notes",
    endpoint: "/v1/video-notes",
    label: "video note",
    pluralLabel: "video notes",
    idPrefix: "vnote",
    mediaKey: "video",
    defaultContentType: DEFAULT_CONTENT_TYPE,
    extensionForContentType,
    mediaDescriptor: ({ id, contentType, bytes }) => ({
      kind: "note",
      content_type: contentType,
      bytes,
      href: `/v1/video-notes/${encodeURIComponent(id)}/video`,
    }),
  });
  return {
    notesDir: store.notesDir,
    create: store.create,
    list: store.list,
    get: store.get,
    videoPath: store.blobPath,
    readBytes: store.readBytes,
    readStream: store.readStream,
    remove: store.remove,
    status: store.status,
  };
}

function createVideoNoteHandlers(options = {}) {
  const store = options.store || createVideoNotesStore({ dataDir: options.dataDir });
  const handlers = createMediaNoteHttpHandlers({
    store,
    blobPath: (id) => store.videoPath(id),
    maxBytes: Number(options.maxBytes || DEFAULT_MAX_NOTE_BYTES),
    recordCreated: options.recordCreated,
    pathPrefix: "/v1/video-notes/",
    label: "video note",
    mediaSegment: "video",
    headerName: "video-note",
  });
  return {
    create: handlers.create,
    list: handlers.list,
    get: handlers.get,
    sendVideo: handlers.sendBlob,
    remove: handlers.remove,
  };
}

function videoInlinePart(note, bytes) {
  if (!note || !Buffer.isBuffer(bytes) || bytes.length <= 0) return null;
  return {
    inlineData: {
      mimeType: bareMimeType(note.content_type) || DEFAULT_CONTENT_TYPE,
      data: bytes.toString("base64"),
    },
  };
}

function bareMimeType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

function extensionForContentType(contentType) {
  const lower = bareMimeType(contentType);
  if (lower === "video/webm") return ".webm";
  if (lower === "video/mp4") return ".mp4";
  return ".bin";
}

module.exports = {
  createVideoNotesStore,
  createVideoNoteHandlers,
  videoInlinePart,
  bareMimeType,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_MAX_NOTE_BYTES,
};
