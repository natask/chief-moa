## ADDED Requirements

### Requirement: Cascaded turns stream multiple ordered PCM frames over the unchanged envelope
The gateway SHALL emit a cascaded voice turn's assistant audio as N ordered
binary PCM16 frames between one `assistant_audio_start` and one
`assistant_audio_done` event, using the existing WS event set with no new
event types. `assistant_audio_start` SHALL carry an additive `streaming: true`
flag when the pipelined path produced the turn. `turn_done` SHALL carry
additive `first_audio_ms` and `tts_segments` fields with every other
`turn_done` field unchanged.

#### Scenario: A multi-sentence reply plays as multiple ordered frames
- **WHEN** a cascaded turn's reply chunks into 3 or more speakable sentences
- **THEN** the client receives one `assistant_audio_start`, 3 or more binary
  PCM frames in sentence order, one `assistant_audio_done`, and one
  `turn_done` with `first_audio_ms` and `tts_segments` set

#### Scenario: assistant_text follows the first audio frame on a multi-chunk reply
- **WHEN** a cascaded turn streams more than one TTS chunk
- **THEN** `assistant_text` (the full reply text) is sent after the first
  binary PCM frame, once the LLM stream ends, instead of before any audio

#### Scenario: The kill switch reproduces the exact non-streaming sequence
- **WHEN** `VOICE_STREAMING=0` is set for a turn
- **THEN** the gateway calls the non-streaming reasoning path, performs one
  blocking synthesize call, emits exactly one binary audio frame, and sends
  `assistant_text` before that frame, matching today's pre-streaming behavior

### Requirement: A turn-identity interruption guard prevents cross-turn audio corruption
The gateway SHALL re-check turn identity and non-terminal status before every
`sendAudio` call, immediately before the socket write inside `sendAudio`, and
before `onAssistantAudioDone`, and SHALL abort emission for a superseded turn
without emitting a client-visible error. `writeAssistantAudio` SHALL return
without writing or re-creating the stream when the turn's assistant-audio
stream is closed or the turn status is terminal.

#### Scenario: A barge-in stops the old turn's audio cleanly
- **WHEN** a new `session_start` supersedes an in-flight streaming turn
  between two chunk emissions
- **THEN** no further binary frames or events are sent for the superseded
  turn, and no `TurnSupersededError` reaches the client as a turn error

#### Scenario: A late write after stream close does not corrupt the record
- **WHEN** a TTS chunk resolves after `closeAssistantAudioStream` has latched
  the turn's assistant-audio stream closed
- **THEN** the late write is dropped with no throw, no stream re-creation, and
  no rewrite of the already-finalized turn record

### Requirement: A pure sentence/clause chunker governs TTS chunk boundaries
The gateway SHALL slice streamed reply text into speakable chunks using
sentence-ending punctuation (including Ethiopic `። ፧ ፨`) as the primary
boundary, clause-ending punctuation (including Ethiopic `፣ ፤ ፥`) once the
pending buffer exceeds a minimum length, and a hard split at the last
whitespace past a maximum length. A bracketed expressive-speech tag SHALL
never be split from the prose it modifies.

#### Scenario: Ethiopic sentence enders produce a boundary
- **WHEN** streamed text contains an Ethiopic full stop (`።`) followed by
  whitespace or end of buffer
- **THEN** the chunker emits a completed chunk ending at that boundary

#### Scenario: A Latin abbreviation period is not treated as a sentence boundary
- **WHEN** streamed text contains a period following a known abbreviation
  (e.g. "Dr.") with a lowercase or continuing word after it
- **THEN** the chunker does not emit a chunk boundary at that period

### Requirement: Pipelined TTS degrades to text-only on a mid-stream synthesis fault instead of failing the turn
The gateway SHALL bound concurrent synthesis requests per turn, emit chunks in
strictly ordered sequence regardless of synthesis completion order, and on a
chunk synthesis fault SHALL stop further audio emission for that turn while
still delivering the full `assistant_text`, emitting `assistant_audio_done` if
audio had started, and completing the turn with `tts_spoke` and `tts_error`
set rather than raising a turn-level error.

#### Scenario: A failed chunk stops audio but the turn still completes with text
- **WHEN** a chunk's hosted TTS request fails after at least one earlier chunk
  already played
- **THEN** no further chunks are requested, the client still receives the full
  `assistant_text`, and `turn_done` reports `status: "completed"` with
  `tts_error` set and `tts_spoke: true`

### Requirement: A streaming fault trips a per-process circuit breaker to the non-streaming path
The gateway SHALL count streaming-path faults per process and, once a
threshold is reached, SHALL latch subsequent turns in that process onto the
non-streaming path without requiring an operator action or redeploy, logging
the trip once.

#### Scenario: Repeated streaming faults fall back automatically
- **WHEN** the streaming path faults 3 times in one gateway process
- **THEN** the next voice turn in that process runs the non-streaming
  reasoning and synthesis path, and the trip is logged exactly once

### Requirement: Provider capability flags expose streaming support without changing the transport contract
The gateway SHALL expose `streaming_tts` and `streaming_reasoning` capability
flags per configured voice provider through `/health`, resolved from a
registry-driven provider seam, while keeping `processTurn(turn, hooks)`,
`status()`, and `synthesizeAssistantSpeech` unchanged for every caller.

#### Scenario: Health reports streaming capability for the active provider
- **WHEN** a client calls `GET /health` against a gateway running the
  streaming-capable cascaded provider
- **THEN** the response's voice capability set includes `streaming_tts: true`

### Requirement: Turn records stay additive-only and require no migration
The gateway SHALL persist a streaming turn's assistant audio as the same
single concatenated PCM artifact used today, and SHALL add `streaming`,
`first_audio_ms`, and `tts_segments` only as additive fields on the provider
result and canonical turn record, so an old reader ignores the new fields and
a record produced before this change is read as the non-streaming default.

#### Scenario: A streaming turn's audio is stored as one file
- **WHEN** a streaming turn emits multiple TTS chunks
- **THEN** the gateway appends every chunk to the same `${turnId}.assistant.pcm`
  artifact used by a non-streaming turn, with a correspondingly larger chunk
  count

#### Scenario: Rollback needs no data migration
- **WHEN** the gateway is redeployed to the previous ref or run with
  `VOICE_STREAMING=0`
- **THEN** turn records are byte-identical to today's shape minus the
  additive streaming fields, and no backfill or schema change is required
