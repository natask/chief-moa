const AUDIO_NOTES_PATH = "/v1/audio-notes";

function cleanText(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function audioNoteItems(payload) {
  const notes = Array.isArray(payload?.notes) ? payload.notes : [];
  return notes
    .filter((note) => note && typeof note === "object" && cleanText(note.id, 160))
    .slice()
    .sort((left, right) => {
      const timeOrder = Date.parse(right.created_at || "") - Date.parse(left.created_at || "");
      if (Number.isFinite(timeOrder) && timeOrder !== 0) return timeOrder;
      return cleanText(right.id, 160).localeCompare(cleanText(left.id, 160));
    });
}

function audioNotePath(note, suffix = "") {
  const id = cleanText(note?.id, 160);
  if (!id) throw new Error("Audio note identity is missing.");
  return `${AUDIO_NOTES_PATH}/${encodeURIComponent(id)}${suffix}`;
}

function audioNoteAudioPath(note) {
  const advertised = cleanText(note?.audio?.href, 500);
  if (advertised.startsWith(`${AUDIO_NOTES_PATH}/`) && advertised.endsWith("/audio")) {
    return advertised;
  }
  return audioNotePath(note, "/audio");
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "size unavailable";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatDuration(value) {
  if (value === null || value === undefined || value === "") return "duration unavailable";
  const durationMs = Number(value);
  if (!Number.isFinite(durationMs) || durationMs < 0) return "duration unavailable";
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

function audioNoteState(note) {
  const transcript = note?.transcription && typeof note.transcription === "object"
    ? note.transcription
    : {};
  const state = cleanText(
    note?.transcription_state || transcript.state || note?.processing_state || "stored",
    60,
  ).toLowerCase();
  const error = cleanText(
    note?.transcription_error || transcript.error || note?.failure_message || note?.error,
    300,
  );
  return {
    state,
    error,
    failed: state === "failed" || state === "error" || Boolean(error),
    retryable: note?.retryable === true || transcript.retryable === true,
  };
}

function audioNoteFilename(note, extension = "") {
  const label = cleanText(note?.label, 120) || cleanText(note?.id, 120) || "voice-note";
  const safe = label.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "voice-note";
  if (extension) return `${safe}.${extension.replace(/^\./, "")}`;
  const contentType = cleanText(note?.content_type || note?.audio?.content_type, 160).toLowerCase();
  if (contentType.startsWith("audio/webm")) return `${safe}.webm`;
  if (contentType.startsWith("audio/l16")) return `${safe}.pcm`;
  return `${safe}.audio`;
}

async function audioNotePlaybackBlob(note, sourceBlob) {
  const contentType = cleanText(note?.content_type || sourceBlob?.type, 160).toLowerCase();
  if (!contentType.startsWith("audio/l16")) return sourceBlob;
  const pcm = new Uint8Array(await sourceBlob.arrayBuffer());
  const channels = 1;
  const sampleRate = 16000;
  const bitsPerSample = 16;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeText = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bitsPerSample / 8, true);
  view.setUint16(32, channels * bitsPerSample / 8, true);
  view.setUint16(34, bitsPerSample, true);
  writeText(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm], { type: "audio/wav" });
}

export {
  AUDIO_NOTES_PATH,
  audioNoteAudioPath,
  audioNoteFilename,
  audioNoteItems,
  audioNotePath,
  audioNotePlaybackBlob,
  audioNoteState,
  formatBytes,
  formatDuration,
};
