# Voice reply variation: root cause

Date: 2026-07-03. Surface: browser extension live voice via
`WS /v1/voice/sessions` on the vertex-live provider
(`gemini-live-2.5-flash-native-audio`). Evidence is from the live gateway's
stored data, read-only: `gateway/data/voice-provider-events.jsonl` and
`gateway/data/voice-sessions/*/*.json`. All affected turns have
`source: agee-extension`.

## Summary

The four observed behaviors are four outcomes of the same pipeline racing
itself. Nothing waits for the pieces that arrive late, and every missing piece
is papered over with a fabricated value instead of an explicit failure.

1. Start-of-utterance truncation: the extension does not open the microphone
   until the gateway session handshake finishes, so the first ~0.5-2 s of
   speech is never captured at all.
2. "Voice captured.": the gateway closes the Gemini socket the moment the model
   turn completes; when Gemini's input transcription trails that moment, the
   provider fabricates the placeholder transcript `"Voice captured."`, sends it
   to the client as `transcript_final`, and stores it as canonical history.
3. "done": on the native-audio model the gateway never requests output
   transcription (`supportsOutputTranscription()` is false), so `assistant_text`
   is always empty; the extension cue card falls back to the literal string
   `"Done."` (`content.js`), and turns with no output at all still complete
   "successfully".
4. Proper reply: everything happened to arrive before each deadline.

## Evidence

From `voice-sessions` turn metadata (most recent session,
`agee_78d3efd4-...`):

- `voice_mr4nxgr1`: `audio.bytes = 7060` — 0.22 s of PCM16 for a full spoken
  utterance. Almost all leading audio was lost before capture started. STT got
  nothing usable; stored transcript is `"Voice captured."`; the assistant still
  replied (48 KB audio) — to a fifth of a word.
- `voice_mr4o0bmz`: `audio.bytes = 302974` (~9.5 s of speech), transcript
  `"Voice captured."`, no assistant output. Gemini never delivered
  `inputTranscription` before the turn resolved; the placeholder was fabricated
  and stored, and the client showed a fake turn.
- Fragment transcripts on completed turns: `"uno"`, `"responding"`,
  `"Shatnari"`, `"period cold"`, `"which for the"`, `"Taken what I am
  saying."` — tail ends of sentences whose starts were cut off.
- Many completed turns with `assistant_audio.bytes = 0` and empty
  `assistant.text` — the extension shows `"Done."` for each of these.

## Code paths per behavior

### 1. Start-of-utterance truncation

`browser_extension/extension/background.js`:

- `startVoiceSessionProxy()` sequence: fetch session ticket (HTTP round trip)
  -> open WebSocket -> send `session_start` -> gateway processes -> gateway
  sends `session_ready` -> only then (`forwardVoiceSessionEvent`, the
  `session_ready` branch) does `startOffscreenVoiceCapture()` run, which may
  still need to create the offscreen document, `getUserMedia`, and load the
  audio worklet.
- Everything the user says between the wake key and worklet start is never
  captured. The delay is network + Chrome dependent, so the truncation length
  varies per turn — the nondeterminism the user sees.
- Contrast: the Android client
  (`MoaStreamingVoiceSessionController.CaptureCallback.onPcmChunk`) starts the
  mic immediately and buffers PCM until `session_ready`, then flushes. The
  extension has no equivalent buffer.

Secondary gateway window: `voice-session-server.js handleAudio()` silently
drops any frame that arrives while `this.turn` is null or not yet `recording`
(deliberate for stale trailing frames, but it also swallows leading frames
that race `session_start` processing).

### 2. "Voice captured."

`gateway/lib/voice-providers.js` (`GeminiLiveVoiceProvider`):

- `createLiveTurnSession()`: `handleServerMessage` calls `resolveOnce()` as
  soon as `serverContent.turnComplete` arrives, and `scheduleIdleComplete()`
  resolves 2.5 s after the last audio chunk when `generationComplete` never
  shows. `resolveOnce` immediately `closeQuietly(websocket)` — any
  `inputTranscription` fragments Gemini has not yet delivered are discarded.
- `result()` then fabricates: `transcript: sttTranscript || textTurnText ||
  "Voice captured."`. Same fabrication in `processTurn()`
  (`state.inputTranscript = "Voice captured."`).
- `voice-session-server.js completeTurnWithProviderResult()` sends that fake
  text to the client as a `transcript_final` event (`onTranscriptFinal`) and
  stores it as the canonical turn transcript.
- `server.js` then injects the stored fake into the NEXT turn's model context:
  `voiceLiveContextPrompt()` and `durableSessionContextBlock()` render recent
  turns as `user: Voice captured.` with no synthetic-source filtering (only
  `previousUserTranscript()` filters). The model reads the placeholder as
  something the user said and can parrot it back.

Timing dependence: whether Gemini's `inputTranscription` lands before
`turnComplete`/the idle timer is a race against the provider — hence "sometimes
fine, sometimes 'voice captured'".

### 3. "done"

- `gateway/lib/voice-providers.js supportsOutputTranscription()` returns false
  for any `native-audio` model, so `outputAudioTranscription` is never
  requested and `assistant_text` is always empty on the deployed model
  (`gemini-live-2.5-flash-native-audio`, confirmed via `/health`).
- `browser_extension/extension/content.js finishLiveVoiceDone()`:
  `const summary = state.assistantText || "Done.";` — every audio-only or
  empty reply renders the literal `"Done."`.
- Turns with no transcript AND no assistant output still complete with
  `turn_done status=completed`, so a fully failed turn also shows `"Done."`.

### 4. Proper reply

Input transcription arrived before resolve, the model produced audio, and (on
non-native models) output transcription produced assistant text. All three
races won.

## Fix (this change)

1. Provider: never fabricate `"Voice captured."`. When the model turn completes
   with no input transcript, hold the socket open for a bounded grace window
   (`GEMINI_LIVE_TRANSCRIPT_GRACE_MS`, default 1500 ms; fragments restart a
   short `GEMINI_LIVE_TRANSCRIPT_SETTLE_MS` settle timer) so trailing
   `inputTranscription` lands. If it still never arrives, return an empty
   transcript with `transcript_source: "synthetic"`.
2. Session server: a turn with no transcript and no assistant output is an
   explicit failure, not a fake turn — send `turn_done status=no_speech`
   (reason `stt_empty`), record a `turn_no_speech` provider event, and store no
   canonical conversation record. A turn with real assistant output but no
   transcript completes with an empty (never fabricated) transcript.
3. Gateway context packs: legacy stored `"Voice captured."` / synthetic
   transcripts render as `(speech was not transcribed)` so the model is never
   prompted with the placeholder.
4. Gateway session server: buffer audio frames that arrive before the turn is
   ready (bounded size + age) and flush them into the turn, instead of silently
   dropping leading audio.
5. Extension: start microphone capture immediately when the voice session is
   requested (parallel with the ticket/WS handshake), buffer PCM in the
   background service worker until `session_ready`, then flush — same pattern
   Android already uses. Map `turn_done status=no_speech` to an explicit
   "I didn't catch that." cue, and stop rendering `"Done."` when a spoken
   reply played (show the transcript-safe marker instead).

## Verification

- `gateway/scripts/smoke-voice-transcript-determinism.js` (new, in
  `npm run check`): delayed-transcript settle gate, missing-transcript
  `no_speech` path, missing-transcript-with-audio path (no placeholder
  anywhere), and leading-audio capture through the session server.
- `gateway/scripts/eval-voice-roundtrip.js`: now sends the first audio frame
  before `session_ready` and asserts the stored PCM equals the full fixture
  audio byte-for-byte (leading-audio regression).
- `cd gateway && npm run check`; `cd browser_extension && npm run verify`.
