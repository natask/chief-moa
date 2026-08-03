import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIO_NOTES_PATH,
  audioNoteAudioPath,
  audioNoteFilename,
  audioNoteItems,
  audioNotePath,
  audioNotePlaybackBlob,
  audioNoteState,
  formatBytes,
  formatDuration,
} from "../extension/audio-note-library.js";

test("audio note list is filtered and sorted newest first", () => {
  const notes = audioNoteItems({ notes: [
    { id: "older", created_at: "2026-08-01T10:00:00.000Z" },
    null,
    { id: "newer", created_at: "2026-08-03T10:00:00.000Z" },
    { created_at: "2026-08-04T10:00:00.000Z" },
  ] });
  assert.deepEqual(notes.map((note) => note.id), ["newer", "older"]);
  assert.deepEqual(audioNoteItems(null), []);
});

test("audio note routes stay inside the inert authenticated media contract", () => {
  const note = { id: "note with/slash", audio: { href: "/v1/chat" } };
  assert.equal(AUDIO_NOTES_PATH, "/v1/audio-notes");
  assert.equal(audioNotePath(note), "/v1/audio-notes/note%20with%2Fslash");
  assert.equal(audioNoteAudioPath(note), "/v1/audio-notes/note%20with%2Fslash/audio");
  assert.equal(
    audioNoteAudioPath({ id: "advertised", audio: { href: "/v1/audio-notes/advertised/audio" } }),
    "/v1/audio-notes/advertised/audio",
  );
  assert.throws(() => audioNotePath({}), /identity is missing/);
});

test("audio note metadata and processing failure remain visible and bounded", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatDuration(65000), "1:05");
  assert.equal(formatDuration(null), "duration unavailable");
  assert.deepEqual(audioNoteState({ transcription: {
    state: "failed",
    error: "provider unavailable",
    retryable: true,
  } }), {
    state: "failed",
    error: "provider unavailable",
    failed: true,
    retryable: true,
  });
  assert.equal(audioNoteFilename({ id: "note_1", label: "A note / idea", content_type: "audio/webm" }), "A-note-idea.webm");
  assert.equal(audioNoteFilename({ id: "note_2", content_type: "audio/L16; rate=16000" }), "note_2.pcm");
});

test("raw PCM notes are wrapped as playable WAV without changing sample bytes", async () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const source = new Blob([pcm], { type: "audio/L16; rate=16000; channels=1" });
  const playable = await audioNotePlaybackBlob({ content_type: source.type }, source);
  assert.equal(playable.type, "audio/wav");
  const bytes = new Uint8Array(await playable.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WAVE");
  assert.deepEqual([...bytes.slice(44)], [...pcm]);

  const webm = new Blob([pcm], { type: "audio/webm" });
  assert.equal(await audioNotePlaybackBlob({ content_type: "audio/webm" }, webm), webm);
});
