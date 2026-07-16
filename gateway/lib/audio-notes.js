"use strict";

const { createMediaNoteStore } = require("./media-note-store");
const { createMediaNoteHttpHandlers } = require("./media-note-http");

const DEFAULT_CONTENT_TYPE = "audio/L16; rate=16000; channels=1";

function createAudioNotesStore(options = {}) {
  const store = createMediaNoteStore({
    dataDir: options.dataDir,
    maxTotalBytes: options.maxTotalBytes,
    directory: "audio-notes",
    endpoint: "/v1/audio-notes",
    label: "audio note",
    pluralLabel: "audio notes",
    idPrefix: "note",
    mediaKey: "audio",
    defaultContentType: DEFAULT_CONTENT_TYPE,
    extensionForContentType,
    mediaDescriptor: ({ id, contentType, bytes }) => ({
      kind: "note",
      encoding: encodingForContentType(contentType),
      content_type: contentType,
      bytes,
      href: `/v1/audio-notes/${encodeURIComponent(id)}/audio`,
    }),
  });
  return {
    notesDir: store.notesDir,
    create: store.create,
    list: store.list,
    get: store.get,
    audioPath: store.blobPath,
    readStream: store.readStream,
    status: store.status,
  };
}

function createAudioNoteHandlers(options = {}) {
  const store = options.store || createAudioNotesStore({ dataDir: options.dataDir });
  const handlers = createMediaNoteHttpHandlers({
    store,
    blobPath: (id) => store.audioPath(id),
    maxBytes: Number(options.maxBytes || 32 * 1024 * 1024),
    recordCreated: options.recordCreated,
    pathPrefix: "/v1/audio-notes/",
    label: "audio note",
    mediaSegment: "audio",
    headerName: "audio-note",
  });
  return {
    create: handlers.create,
    list: handlers.list,
    get: handlers.get,
    sendAudio: handlers.sendBlob,
  };
}

function extensionForContentType(contentType) {
  const lower = String(contentType).toLowerCase();
  if (lower.startsWith("audio/l16")) return ".pcm";
  if (lower.startsWith("audio/webm")) return ".webm";
  return ".bin";
}

function encodingForContentType(contentType) {
  const lower = String(contentType).toLowerCase();
  if (lower.startsWith("audio/l16")) return "pcm16";
  if (lower.startsWith("audio/webm")) return "webm";
  return "binary";
}

module.exports = {
  createAudioNotesStore,
  createAudioNoteHandlers,
  DEFAULT_CONTENT_TYPE,
};
