# Voice reliability and profile-derived languages (2026-07-06)

Implemented as part of the cross-surface fixes lane split
(`scratch/agent-loop/2026-07-06-cross-surface-fixes/tickets.md`).

## Contract deltas

- A voice turn must always terminate observably. Commit/text turn processing
  errors emit `turn_done{status:"error"}` in addition to the `error` event and
  clear the open turn. Model and Cloud TTS fetches run under bounded timeouts
  (`MODEL_FETCH_TIMEOUT_MS`, `CLOUD_TTS_TIMEOUT_MS`), so an upstream hang
  becomes an error turn instead of an eternally open turn.
- `turn_done` on completed cascaded turns carries `tts_spoke` and
  `reply_language`. Clients use them: Android speaks the assistant text with
  device TTS when `tts_spoke=false` or no assistant audio arrived (the am-ET
  case), surfaces `no_speech` and error statuses audibly and visibly, shows a
  message on a mid-turn socket drop, and re-arms its turn watchdog on every
  streaming event.
- Chirp STT now recognizes with `languageCodes:["auto"]` for batch and
  streaming. The agent profile's `input_languages` (primary plus at most one
  alternate) become a bounded custom transcription prompt;
  `CHIRP_PROMPT_LANGUAGE_CODES` is only the boot-time fallback when no profile
  store is wired. Provider-reported language is evidence only and does not
  reject or drop a transcript.
- End-to-end replay eval: `gateway/scripts/eval-voice-e2e.js`
  (`npm run eval:voice:e2e`) boots the real server, mints a voice-session
  ticket, drives the real WS upgrade, replays PCM (fixtures or any recorded
  audio via `--audio`), and asserts transcript, assistant output, bounded
  time-to-`turn_done` (including an injected reasoner stall), and stored-PCM
  fidelity. Live-provider mode stays env-gated (`VOICE_EVAL_LIVE=1`).

## Related

- Canonical shared session across surfaces: `GET /v1/sessions/default`; chat,
  voice, and browser turns that omit ids resolve to the per-account shared
  session (see `message-broker-session-router`).
- Durable `user_address` profile field (default "master") emitted after the
  identity instruction in both prompt assemblies.
