# Critique

## 1. Contradictions / failure risks

- "No transcription" conflicts with the repo rule "spoken input must never be
  lost" only if record mode is routed through the voice-turn pipeline, which
  always requests transcripts. Fix: record mode must be a distinct capture kind
  (`audio_note`), not a voice turn, so the no-STT constraint is by construction,
  not by flag-checking inside the STT path.
- Riding the existing WS voice session risks accidentally invoking the provider
  pipeline (Chirp/Gemini) and burning STT cost per note. A plain HTTP upload
  (client records locally, POSTs the finished blob) removes that whole class of
  bugs and works offline-ish (retry until sent).
- Live gateway freeze: any gateway change must not restart or mutate the running
  service. Implementation happens in a worktree; deploy is a gated promotion.
- The Android lane can stall on emulator/SDK issues; it must not block the
  gateway + extension milestone. Android is a second wave.

## 2. Missing primitives

- Storage: a new `audio_note` record. Attach to existing primitives:
  `product_event` (append `audio_note.created`) + blob under `DATA_DIR`. Keep it
  event-sourced like work-history, but the smallest viable slice is a JSONL
  index + `.wav`/`.webm` blobs under `DATA_DIR/audio-notes/`, mirrored into the
  product event substrate.
- API: `POST /v1/audio-notes` (multipart or raw body + headers),
  `GET /v1/audio-notes`, `GET /v1/audio-notes/:id/audio`. Same token auth as the
  rest of `/v1`.
- Client state: a visible "recording" mode state so the user knows capture is
  live, and an explicit end that confirms the note was stored (receipt).
- Verification: deterministic smoke that POSTs synthetic PCM/webm and reads it
  back byte-identical; no network providers involved.

## 3. Smallest viable loop

Gateway `audio_note` store + HTTP endpoints + smoke, THEN extension record mode
(button in the overlay/command surface, MediaRecorder webm upload), THEN Android.
Each lane commits separately. Deploy of the live gateway is recorded as a gated
blocker unless the user says promote.

## External critique

Codex critique will run as a sub-agent during implementation review (user
explicitly authorized codex sub-agents). Not blocking planning.
