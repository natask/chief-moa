# Voice delivery controls: speaking rate, tone, spoken tool acks, audible language switch

## Why

Three gaps in the cascaded voice pipeline made the assistant feel slow and
mute at the wrong moments:

1. The TTS request carried no pace control at all. The reply always played at
   the provider's default speed, and the user could not say "speak faster".
2. A tool round was dead air. Text emission stops at the first tool call, so
   while an agent launched or a setting changed, the user heard nothing until
   the post-tool reply streamed. People solved this pattern already: the agent
   says "okay, doing that now" first.
3. A reply-language change was silent. The switch applies from the next turn
   and the model was not required to confirm it out loud, so the user could
   not tell whether it happened.

## What changes

- Two new durable profile fields: `speaking_rate` (0.5-2.0, 1.0 = provider
  normal, default 1.5 so the assistant is fast out of the box) and
  `voice_tone` (a few free-text words fed to the expressive style prompt;
  "" = neutral; the reset words "neutral"/"none"/"default" clear it).
  Env defaults `VOICE_SPEAKING_RATE` / `VOICE_TONE`.
- Delivery is pinned per turn like the voice: turn effective profile (session
  override) -> persisted profile -> env default. `session_start
  profile_override.speaking_rate|voice_tone` gives a session-scoped override
  (a pet that talks fast) that never persists.
- Provider mapping: classic Cloud TTS / Chirp3-HD voices get
  `audioConfig.speakingRate`; the Gemini-TTS leg gets a natural-language pace
  instruction composed into `input.prompt` (audioConfig.speakingRate is
  unreliable on Gemini-TTS), ordered per-turn `[style: ...]` first, then
  `voice_tone`, then pace.
- The model owns pace and tone by tool call, like language: a new
  `voiceDeliveryDirective` states the current rate/tone and how to map
  "a bit faster" (+0.25), "much faster" (+0.5), "as fast as you can" (2.0),
  named multipliers, and tone words onto `update_agent_profile`, including
  asking one short follow-up when the request is vague.
- Spoken tool acknowledgments: `voiceToolAckDirective` tells the model to say
  one short line before real tool calls. When it goes straight to tools, the
  streaming tool loops fire a new `onToolRound` tap and the reasoner speaks a
  canned localized ack (en/am) through a new pipeline `pushImmediate` tap that
  bypasses the sentence chunker, so the line plays immediately instead of
  waiting for min-chars. Quick lookups (`get_profile_options`,
  `context_management`) never trigger the ack. Like profile-control
  confirmations, the ack is gateway-produced speech, not part of the stored
  reply.
- Audible language switch: `languageControlDirective` now requires the model
  to confirm a reply-language change out loud in the NEW language, so the user
  hears the switch in the same turn even though the pinned TTS language
  updates next turn.
- Ops: cascaded provider status (and `/health voice_stream.provider`) reports
  `tts_speaking_rate` and `tts_tone`.

## What does not change

- The wire envelope, turn records, and the streaming chunk pipeline contract
  from `streaming-cascaded-voice` are untouched; `pushImmediate` counts as a
  delta so the zero-delta fallback never double-speaks.
- Clients need no changes; the rate is baked into the synthesized PCM.
- The stage seam (`voice-stages.js`) keeps its shape; `synthesize()` gains
  optional `speakingRate`/`tone` fields.

## Follow-up shipped: guaranteed client-side speed

The Gemini-TTS leg (the live default) ignores `audioConfig.speakingRate` and
only approximates pace from prompt words, so `speaking_rate` was not a hard
guarantee there. Added `VOICE_TTS_CLIENT_RATE` mode (off by default):

- When on, the gateway generates natural-speed Gemini-TTS audio (pace words
  dropped from the style prompt) and emits `playback_rate` on
  `assistant_audio_start`; the client resamples the PCM to the target speed
  exactly once (`clientPlaybackRate`/`paceInPrompt` gate the double-apply).
- When off, audio is baked at the target pace and `playback_rate` stays 1.0,
  so live behavior and un-updated clients are unchanged.
- All three surfaces apply it: pet page + browser extension set
  `source.playbackRate` and advance their schedule cursor by
  `bufferDuration / rate`; Android applies `AudioTrack.setPlaybackParams`
  (`PlaybackParams.setSpeed`). Absent field = 1.0 everywhere.
- Rollout is order-free: every surface is inert until the gateway flag flips,
  so there is no old/new client hazard.
- `/health voice_stream` reports `tts_client_rate_mode`.

## Streaming TTS: decision (was point 6)

Research verdict (primary sources): Chirp 3 HD `StreamingSynthesize` is
**gRPC-bidi only** with no REST/WebSocket binding (the RPC carries no
`google.api.http` annotation) and its HD voices do not speak Amharic, so it
cannot be the default for a multilingual assistant without adding a gRPC
dependency. The only no-gRPC streaming path is Gemini
`:streamGenerateContent?alt=sse` on `generativelanguage.googleapis.com`, which
needs a separate API-key auth, is 3.1+ only, does **not** honor
`speaking_rate`, and has a reported >60s truncation bug. Meanwhile the shipped
`streaming-cascaded-voice` pipeline already starts audible playback mid-reply
by synthesizing per sentence chunk, so seamless start (the user's point 5) is
already met. True streaming TTS is therefore a user decision with a real fork
(add gRPC Chirp en-US streaming / build Gemini SSE with caveats / keep
chunked), not a silent pick. Recorded, not built.

## Out of scope (recorded follow-ups)

- True streaming TTS (`streamingSynthesize` bidi for Chirp3-HD, gRPC-only; or
  Gemini `streamGenerateContent` SSE): pending the user's provider decision
  above. The current pipeline is many batch `text:synthesize` calls over
  sentence chunks and already streams playback.
- End-to-end voice-model backends (native_live providers) honoring
  speaking_rate; Gemini/Vertex Live sessions have no equivalent knob today.
