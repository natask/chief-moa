# voice-delivery-controls

## ADDED Requirements

### Requirement: Speaking rate is a durable, per-turn-pinned delivery control

The gateway SHALL expose a `speaking_rate` profile field (0.5-2.0, 1.0 =
provider-normal speed, default 1.5) and SHALL pin one rate per voice turn from
the turn's effective profile (session override first, then persisted profile,
then env default). On classic Cloud TTS voices the rate SHALL ride
`audioConfig.speakingRate`; on the Gemini-TTS leg it SHALL ride a
natural-language pace instruction appended to `input.prompt`.

#### Scenario: user says "speak faster"

- GIVEN the effective profile has `speaking_rate: 1.5`
- WHEN the user says "speak a bit faster" on a spoken turn
- THEN the model calls `update_agent_profile` with `speaking_rate: 1.75`
- AND confirms briefly, and the next spoken reply synthesizes with the new
  rate (audioConfig on classic voices, pace words in the style prompt on
  gemini-tts).

#### Scenario: session override pins a pet's fast voice

- GIVEN a `session_start` with `profile_override.speaking_rate: 2` and
  `profile_override.voice_tone: "playful"`
- WHEN the session's turns synthesize
- THEN every chunk of those turns uses rate 2 and the playful tone
- AND the persisted profile is unchanged for other sessions.

### Requirement: Tool rounds are never dead air on streaming voice turns

On a streaming voice turn, when the model starts a tool round that does real
work without having spoken yet, the gateway SHALL speak one short localized
acknowledgment through the streaming pipeline immediately (bypassing the
sentence chunker), and the reasoning model SHALL be directed to speak a
one-line acknowledgment before real tool calls. Quick metadata lookups SHALL
NOT trigger the acknowledgment.

#### Scenario: model goes straight to a tool

- GIVEN a streaming voice turn where the model emits a `launch_agent` tool
  call with no prior text delta
- WHEN the tool round starts
- THEN the user hears one short acknowledgment (for example "Okay - doing
  that now.") before the tool result reply
- AND the stored reply text is only the model's final reply.

### Requirement: A reply-language change is confirmed out loud in the new language

When the model changes the reply language by tool call, it SHALL confirm the
change out loud in the NEW language within the same turn, so the user hears
the switch even though the pinned TTS language updates on the next turn.

#### Scenario: switch to Amharic

- GIVEN the reply language is en-US
- WHEN the user asks the assistant to answer in Amharic
- THEN the model calls the profile tool to set the reply language to am-ET
- AND its spoken confirmation for that turn is in Amharic.
