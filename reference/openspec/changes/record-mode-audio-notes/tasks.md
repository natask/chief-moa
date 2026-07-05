# Tasks

## 1. Gateway Audio Notes

- [x] 1.1 Add a gateway audio-note store that writes note metadata and raw audio
  bytes under `DATA_DIR/audio-notes/`.
- [x] 1.2 Add `POST /v1/audio-notes`, `GET /v1/audio-notes`, and
  `GET /v1/audio-notes/:id/audio` behind existing gateway token auth.
- [x] 1.3 Mirror creation into the product-event stream as
  `audio_note.created`.
- [x] 1.4 Add a deterministic smoke that stores synthetic bytes, reads them back
  byte-identical, verifies list metadata, and proves no STT/LLM/TTS provider is
  invoked.

## 2. Browser Extension

- [x] 2.1 Add an explicit record-mode control/state separate from voice chat.
- [x] 2.2 Capture microphone audio locally and upload only after the user ends
  the note.
- [x] 2.3 Surface stored/failed receipts without clearing the current command
  draft.
- [x] 2.4 Verify with extension `verify` and `smoke`.

## 3. Android

- [x] 3.1 Add a record-mode entry point on the orb/chat surface.
- [x] 3.2 Reuse the local audio capture controller without starting a gateway
  voice session.
- [x] 3.3 Upload a completed note and show a stored/failed receipt.
- [x] 3.4 Verify with `assembleDebug`.

## 4. Architecture And Review

- [x] 4.1 Update `ARCHITECTURE.md` with the record-mode flow and source map.
- [ ] 4.2 Run adversarial review over the gateway and client diffs.
- [x] 4.3 Record deploy blockers; do not promote the live gateway, extension, or
  Android OTA without explicit approval.
