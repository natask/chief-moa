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

## Out of scope (recorded follow-ups)

- True streaming TTS (`v1beta1 streamingSynthesize` bidi) for Chirp3-HD; the
  current pipeline is many batch `text:synthesize` calls over sentence chunks.
- End-to-end voice-model backends (native_live providers) honoring
  speaking_rate; Gemini/Vertex Live sessions have no equivalent knob today.
