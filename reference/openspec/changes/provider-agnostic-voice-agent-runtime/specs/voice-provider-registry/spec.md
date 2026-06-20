## ADDED Requirements

### Requirement: Gateway Voice Provider Registry
The gateway SHALL maintain a registry of voice provider packages and modular
STT, reasoning, and TTS providers with stable identifiers, configuration status,
and capability metadata.

#### Scenario: Health reports configured providers
- **WHEN** Android or an operator requests gateway health or voice runtime status
- **THEN** the response includes the selected voice runtime mode, selected
  providers, configuration status, and supported capability flags

#### Scenario: Provider capability is missing
- **WHEN** a selected provider does not support a requested capability such as
  native assistant audio or mid-session profile update
- **THEN** the gateway reports the limitation explicitly
- **AND** the Android protocol remains stable

### Requirement: Stable Android Voice Protocol
Android SHALL use a provider-independent voice session protocol and SHALL NOT
depend on provider-specific credentials, endpoints, payloads, or session IDs.

#### Scenario: Native live provider selected
- **WHEN** the gateway uses a native live provider such as Gemini Live
- **THEN** Android sends and receives the same Moa voice-session event types
  used by every provider mode

#### Scenario: Modular providers selected
- **WHEN** the gateway uses separate STT, reasoning, and TTS providers
- **THEN** Android sends and receives the same Moa voice-session event types
  used by native live providers

### Requirement: Provider Swap Without Android Release
The gateway SHALL allow changing configured voice/reasoning providers without
requiring an Android APK release when the Moa protocol contract is unchanged.

#### Scenario: Gateway provider changes
- **WHEN** the gateway operator switches from one configured provider package to
  another
- **THEN** Android can continue using the existing gateway URL and voice-session
  protocol
- **AND** gateway health identifies the newly selected provider

### Requirement: Provider Capability Contract
Each provider entry SHALL describe normalized capabilities needed by the voice
runtime.

#### Scenario: Provider metadata loaded
- **WHEN** the gateway loads provider configuration
- **THEN** it records whether each provider supports duplex audio, barge-in,
  server-side endpointing, partial transcripts, assistant audio,
  mid-session profile updates, language hints, and provider-side session resume
