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

### Requirement: Immediate Visibility Does Not Mutate Admitted Turns
The gateway SHALL NOT let an accepted profile write mutate an already admitted
turn's pinned effective profile snapshot. The write MAY become immediately
visible in control-plane reads or to later turns in the same long-lived voice
session. This is target behavior governed by task 14.2a; it MUST NOT be reported
as implemented until the current post-admission reply-setting reads are removed
and the concurrent-turn gate passes.

#### Scenario: A new version is visible right away
- **WHEN** a profile write is accepted through `PUT /v1/agent/profile`,
  `update_agent_profile`, `revert_agent_profile`, `profile_patch`,
  `profile_revert`, or `set_languages`
- **THEN** subsequent profile reads and later turn admissions can resolve the
  new current version immediately
- **AND** the profile history remains append-only

#### Scenario: An active turn keeps its pinned snapshot
- **WHEN** a profile write lands while turn N is already admitted and turn N is
  still recording, reasoning, or speaking
- **THEN** turn N keeps the `profile_version` and effective profile snapshot
  resolved at admission
- **AND** STT, reasoning, TTS voice, speaking rate, tone, reply language, and
  chunking for turn N do not change until turn N completes
- **AND** the new version applies no earlier than the next admitted turn

### Requirement: Canonical Profile Control Commands
The gateway SHALL keep stable control-plane command names for profile reads,
writes, rollback, and sampling.

#### Scenario: Runtime exposes profile controls
- **WHEN** a client or provider-integrated model requests profile control
- **THEN** the HTTP control-plane commands are `GET /v1/agent/profile`,
  `PUT /v1/agent/profile`, `GET /v1/agent/profile/history`,
  `GET /v1/agent/profile/versions`, `POST /v1/agent/profile/rollback`, and
  `POST /v1/agent/profile/reset`
- **AND** the live/cascaded tool names are `update_agent_profile`,
  `revert_agent_profile`, `get_profile_options`, and `start_voice_sampler`
- **AND** the code-mode capability names are `profile_get`, `profile_options`,
  `profile_patch`, `profile_revert`, and `set_languages`

### Requirement: Session-Only Voice Sampling Does Not Persist
Voice sampling and session-only profile overrides SHALL stay ephemeral unless
the user separately requests a durable profile write.

#### Scenario: Voice sampler returns a session-only plan
- **WHEN** the user asks to sample, preview, or hear all supported voices
- **THEN** `start_voice_sampler` returns a `voice_sampler` action plan
- **AND** each sample uses a session-only voice override
- **AND** the durable profile version does not advance unless a separate profile
  write is accepted

### Requirement: Persona Settings Preserve Safety Boundaries
Presentation profile settings SHALL NOT relax safety boundaries. Assistant name,
voice, tone, and language settings SHALL NOT relax tool policy, action
allowlists, approval requirements, local validation, or receipt requirements.

#### Scenario: User changes presentation settings
- **WHEN** the user changes assistant name, voice, tone, heard language, or reply
  language
- **THEN** the profile version may change how Moa sounds or speaks
- **AND** the effective tool policy, action approvals, local checks, and receipt
  requirements remain at least as strict as before the presentation change

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
