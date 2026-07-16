## ADDED Requirements

### Requirement: Explicit Language State
Moa SHALL maintain explicit language state in the agent profile and SHALL NOT
silently change the durable language state from automatic model/provider
detection by default.

For the current implementation slice, the supported language catalog SHALL be
limited to English (`en-US`) and Amharic (`am-ET`) until the user explicitly
expands the product scope.

#### Scenario: Default language active
- **WHEN** a voice session starts with no user-requested language change
- **THEN** Moa uses the configured default language
- **AND** the overlay or full app can show that language state

#### Scenario: Provider detects another language
- **WHEN** a provider detects speech in a different language
- **THEN** Moa may use that signal for transcription quality
- **AND** it does not change the durable output language unless profile policy
  explicitly allows automatic switching

### Requirement: User Requested Language Change
Moa SHALL allow the user to change spoken/input/output language by voice or
settings, and the change SHALL remain active until changed again.

#### Scenario: User switches language by voice
- **WHEN** the user says "speak Amharic", "switch to English", or an equivalent
  explicit language command
- **THEN** Moa updates the agent profile language state
- **AND** shows the new language state in the overlay or full app
- **AND** uses that state for subsequent provider setup and model instructions

#### Scenario: User requests an unsupported language
- **WHEN** the user requests a language outside English or Amharic
- **THEN** Moa does not persist that language in the durable profile
- **AND** the supported-language catalog remains English and Amharic only

#### Scenario: User switches back
- **WHEN** the user explicitly requests a different language after a prior
  language change
- **THEN** Moa creates a new profile version with the requested language
- **AND** future turns use the new language state

### Requirement: Provider Language Hints
The gateway SHALL translate Moa language state into provider-specific language
hints, prompts, or setup fields when the selected provider supports them.

For Chirp 3, the gateway SHALL keep provider language recognition in `auto`
mode and translate the configured input-language state into one bounded custom
transcription prompt shared by streaming and batch recognition. Provider
language detection is evidence only; it SHALL NOT replace the configured Moa
language state or constrain which language Chirp may recognize.

#### Scenario: Provider supports language hints
- **WHEN** the selected STT, live, or TTS provider supports language hints
- **THEN** the gateway sends the configured Moa language state through the
  provider's supported mechanism

#### Scenario: Chirp streams with automatic recognition
- **WHEN** Chirp 3 streaming STT starts for a configured input-language profile
- **THEN** the recognition request uses `languageCodes=["auto"]`
- **AND** its custom prompt names the configured input languages and requires
  verbatim, non-translated transcription with language switches preserved
- **AND** the same prompt contract is used by batch fallback recognition

#### Scenario: Provider lacks language hints
- **WHEN** the selected provider does not support explicit language hints
- **THEN** the gateway includes the language requirement in prompt/profile
  context where possible
- **AND** reports the provider limitation in runtime status

### Requirement: Visible Language Feedback
The Android UI SHALL provide visible feedback when language state changes.

#### Scenario: Language state updated
- **WHEN** Moa applies a language change
- **THEN** the overlay or full app displays the active language without requiring
  the user to infer it from model behavior
