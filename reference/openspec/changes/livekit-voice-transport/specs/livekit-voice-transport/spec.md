## ADDED Requirements

### Requirement: LiveKit transport is flag-gated and inert by default
The gateway SHALL expose the LiveKit voice-transport routes only when
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` are all set, and SHALL
otherwise answer them with a clear `not_configured` response. The default
cascaded WebSocket voice pipeline SHALL be unchanged whether or not the LiveKit
env is set. The browser extension SHALL keep the LiveKit voice mode OFF by
default.

#### Scenario: Token route reports not configured
- **WHEN** a client calls `POST /v1/voice/livekit/token` and the `LIVEKIT_*` env
  is not set
- **THEN** the gateway returns 503 with a `not_configured` status and a reason
  naming the missing env
- **AND** the internal `/v1/internal/voice/*` hooks also return 503

#### Scenario: Token route mints a room token when configured
- **WHEN** a client calls `POST /v1/voice/livekit/token` with a valid gateway
  token and the `LIVEKIT_*` env is set
- **THEN** the gateway returns a short-lived room token, the room
  `moa-{session_id}-{branch_id}`, the caller identity, and `LIVEKIT_URL`

### Requirement: The gateway stays the reasoning, TTS, and record owner
The gateway SHALL drive a LiveKit turn's reasoning, hosted TTS, and turn record
through the SAME code paths the cascaded WebSocket pipeline uses
(`runCascadedVoiceReasoning`, the active provider's `synthesizeSpeech`, and
`recordStreamingVoiceTurn`), so a LiveKit turn is stored and answered identically
to a WebSocket turn. The worker SHALL be transport plus plugins only and SHALL
NOT own reasoning, TTS, or storage.

#### Scenario: Reason hook mirrors the WS reasoner
- **WHEN** the worker calls `POST /v1/internal/voice/reason` with a transcript
- **THEN** the gateway returns the same reply shape the cascaded reasoner
  produces (speak / tts_text / tts_style / language / classification), tagged as
  a `voice-livekit` source turn

#### Scenario: Turn record is stored identically
- **WHEN** the worker calls `POST /v1/internal/voice/turn-record` for a completed
  turn
- **THEN** the gateway persists it through the same durable voice-turn store, and
  the turn is retrievable by id like any other voice turn

### Requirement: Client credential posture is unchanged
Clients SHALL hold only a gateway URL and token; a LiveKit room token SHALL be a
short-lived credential minted by the gateway, matching the browser voice-ticket
posture. Android and the browser extension SHALL NOT store raw LiveKit or
provider credentials.

#### Scenario: Client obtains a room token from the gateway
- **WHEN** the browser extension starts voice in LiveKit mode
- **THEN** it POSTs to the gateway to mint a room token and joins the room with
  that token, holding no LiveKit API key or secret itself

### Requirement: Custom Chirp STT with pinned languages
The LiveKit worker SHALL implement its own Chirp Speech-to-Text v2 plugin (the
Node agents Google plugin has no Chirp STT), constrained to the configured
`languageCodes` (primary plus at most one alternate) with explicit LINEAR16
decoding, and SHALL NOT auto-detect the input language. am-ET turn detection
SHALL fall back to VAD endpointing.

#### Scenario: Recognition is pinned, never auto-detected
- **WHEN** the worker recognizes an utterance
- **THEN** the recognize request pins the configured language codes with explicit
  LINEAR16 decoding, exactly as the gateway's cascaded Chirp path does
