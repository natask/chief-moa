## ADDED Requirements

### Requirement: Versioned Agent Profile
The gateway SHALL store a versioned agent profile that controls prompt,
behavior, language, providers, tool policy, autonomy level, memory policy, and
recovery behavior.

#### Scenario: Turn starts
- **WHEN** the gateway accepts a voice or chat turn
- **THEN** it records the agent profile version used for that turn

#### Scenario: Profile changes
- **WHEN** the user changes prompt, provider, language, tool policy, or autonomy
  settings
- **THEN** the gateway creates a new profile version instead of mutating prior
  turn history

### Requirement: Voice Editable Profile
The gateway SHALL route explicit profile-editing voice intents to profile
updates instead of normal assistant chat.

#### Scenario: User changes behavior by voice
- **WHEN** the user says an instruction such as "change your system prompt to be
  more direct" or "stop using that style"
- **THEN** Moa treats the request as a profile change proposal
- **AND** applies the change only through the profile control plane

#### Scenario: User asks current behavior
- **WHEN** the user asks what prompt, language, provider, or tool mode is active
- **THEN** Moa returns the current profile summary and version

### Requirement: Profile Application Semantics
The gateway SHALL report whether a profile change applies immediately, on the
next turn, or after provider session restart.

#### Scenario: Provider supports mid-session update
- **WHEN** a profile change is compatible with the active provider session
- **THEN** the gateway applies the change and records an immediate application
  event

#### Scenario: Provider requires restart
- **WHEN** the selected provider cannot apply the profile change mid-session
- **THEN** the gateway records that the change will apply on next turn or after
  session restart

### Requirement: Safe Mode And Rollback
The control plane SHALL provide a safe mode that can disable tools, cancel active
non-essential runs, restore a known-good profile, switch providers, and fall
back to text-only operation.

#### Scenario: User triggers safe mode
- **WHEN** the user says "safe mode", "reset your behavior", or uses the full-app
  recovery control
- **THEN** Moa disables non-essential tool execution
- **AND** reverts to a known-good profile or text-only fallback
- **AND** records a recovery event

#### Scenario: User rolls back profile
- **WHEN** the user selects or requests rollback to a previous profile version
- **THEN** the gateway creates a new profile version derived from the selected
  prior version
- **AND** records the rollback source version
