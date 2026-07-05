# Record Mode Audio Notes

## Why

The product has voice-chat paths, but no "just record what I said" mode. The
user asked for a note-taking mode where they press a control, speak, and the raw
audio is stored directly for later review. This must not run STT, LLM, TTS, or
agent routing.

## What Changes

- Add a gateway-owned `audio_note` primitive backed by durable bytes under
  `DATA_DIR` plus a queryable metadata record.
- Add token-authenticated audio-note routes:
  - `POST /v1/audio-notes`
  - `GET /v1/audio-notes`
  - `GET /v1/audio-notes/:id/audio`
- Mirror note creation into the product-event stream as `audio_note.created`.
- Add browser-extension record mode that captures microphone audio and uploads a
  completed note without opening a voice session.
- Add Android record mode as a second UI lane that captures and uploads a note
  without invoking the voice provider pipeline.

## Non-Goals

- No transcription or summarization.
- No note evaluation UI.
- No live gateway deploy or Android OTA publish without explicit promotion.
- No reuse of the voice-session provider path for storage-only notes.

## Boundaries

- Android and browser own local capture UI and user-visible recording state.
- Gateway owns note storage, metadata, auth, and retrieval.
- Model providers are not involved on the record-mode capture path.

## Verification

- Gateway: `cd gateway && npm run check` plus deterministic audio-note smoke.
- Browser extension: `cd browser_extension && npm run verify && npm run smoke`.
- Android: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`.
