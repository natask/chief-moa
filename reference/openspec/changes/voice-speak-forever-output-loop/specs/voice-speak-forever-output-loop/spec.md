## ADDED Requirements

### Requirement: Continuous narration keeps one turn's audio stream flowing across self-prompted rounds
When continuous narration mode is engaged for a cascaded voice turn, the
gateway SHALL generate successive narration segments by re-prompting the
model after each completed reasoning round and SHALL emit all resulting TTS
segments inside the turn's single existing envelope: one
`assistant_audio_start`, N ordered binary PCM frames, one
`assistant_audio_done`, one `turn_done`. No new wire event types SHALL be
introduced. `turn_done` and the canonical turn record SHALL carry additive
`narration_rounds` and `narration_stop_reason` fields for narration turns
and SHALL omit them otherwise.

#### Scenario: A narration spans multiple self-prompted rounds as one turn
- **WHEN** the model engages continuous narration and produces three rounds
  before calling `finish_narration`
- **THEN** the client receives exactly one `assistant_audio_start`, the
  ordered frames of all three rounds, one `assistant_audio_done`, and one
  `turn_done` with `narration_rounds: 3` and
  `narration_stop_reason: "finished"`

### Requirement: Narration mode is default-off and doubly gated
The gateway SHALL NOT expose the narration tools nor honor the
`speak_forever` session override unless the `VOICE_SPEAK_FOREVER`
environment master switch is enabled. Narration SHALL never engage when the
turn's resolved response modality is text, and the session override SHALL
never be written to the stored profile.

#### Scenario: Master switch off means the feature is inert
- **WHEN** `VOICE_SPEAK_FOREVER` is unset and a client sends
  `speak_forever: true` in its session override
- **THEN** the turn behaves exactly as a non-narration cascaded turn and the
  narration tools are absent from the model's tool definitions

### Requirement: Every existing stop path ends a narration immediately
A user barge-in (`session_start` replacing the turn), `cancel_turn`, socket
close, or a `stay_silent` tool call SHALL end the narration loop with no
further model rounds and no further audio frames for the superseded turn.
An interrupted narration SHALL persist `spoken_progress` from the per-frame
segment ledger exactly as a non-narration streamed turn does.

#### Scenario: Barge-in mid-narration goes silent and preserves the stop point
- **WHEN** the client cancels a narration turn after reporting
  `played_segments` covering only part of the emitted segments
- **THEN** no further binary frames, `assistant_text`, or `turn_done` are
  sent for the dead turn beyond the cancel acknowledgement, and the
  canonical record's `spoken_progress` identifies the exact spoken text so
  a later "continue" can resume from that point

### Requirement: Narration spend is bounded by caps and playback pacing
The gateway SHALL bound each narration turn by configurable round, segment,
and wall-clock caps with finite defaults, SHALL report the triggered cap in
`narration_stop_reason`, and SHALL NOT start the next model round while the
count of synthesized-but-unsent segments meets or exceeds the configured
buffer bound.

#### Scenario: The round cap ends a narration gracefully
- **WHEN** a narration reaches the configured maximum number of
  self-prompted rounds
- **THEN** the loop stops after the current round, playback of already
  emitted segments completes, and `turn_done` carries
  `narration_stop_reason: "capped_rounds"`

#### Scenario: Generation waits for playback drain
- **WHEN** the emit buffer holds the configured maximum of unsent segments
- **THEN** the next model round does not begin until at least one buffered
  segment has been sent to the client
