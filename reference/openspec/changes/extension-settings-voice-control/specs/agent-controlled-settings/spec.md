## ADDED Requirements

### Requirement: Change settings by talking to the agent
The user SHALL be able to change settings by speaking or typing to the agent, and
the agent SHALL apply the change to the runtime profile or local config rather
than only answering conversationally.

#### Scenario: Spoken settings change is applied
- **WHEN** the user tells the agent to change a setting (e.g. "set the system prompt to ...", "be terser")
- **THEN** the agent applies it via the gateway profile endpoints and/or local config, and the change takes effect on the next turn

#### Scenario: Applied change reflected in the surface
- **WHEN** the agent applies a settings change
- **THEN** the settings surface updates to show the new value without a manual reload

#### Scenario: Browser Live voice settings change is applied
- **WHEN** the user speaks a settings change through Chrome Live voice, such as
  "use the Kore voice", "only speak English and Amharic", or "your name is Moa"
- **THEN** the extension routes the finalized transcript through the existing
  settings/profile-control path
- **AND** the gateway persists the profile update
- **AND** the next Live voice turn uses the updated identity, voice, or language profile

### Requirement: Agent-readable settings catalog
Every canonical gateway runtime-profile setting SHALL have one stable catalog
entry containing its key, owning scope, current effective value, default,
description, allowed values or constraints, and mutability. The user SHALL be
able to ask the gateway voice agent to list, get, search, and recommend those
settings. Search MAY use semantic ranking, but every result SHALL be grounded in
a catalog entry and identify the effective value.

This initial catalog SHALL NOT claim to enumerate Android preferences or
browser extension-local controls. Those surfaces remain owned by their local
clients until a separately implemented merged projection registers them.

Secrets such as the gateway session token SHALL be represented only by bounded
redacted state and SHALL NOT be returned as catalog values.

#### Scenario: User asks for all settings
- **WHEN** the user asks the gateway voice agent what runtime-profile settings are available
- **THEN** the agent returns a bounded, categorized list of registered gateway-owned settings
- **AND** each returned setting identifies its current effective value or a redacted configured/unconfigured state

#### Scenario: User searches by desired outcome
- **WHEN** the user asks which settings would help with an outcome without naming an exact setting label
- **THEN** the agent returns ranked matching catalog entries with their effective values and grounded explanations
- **AND** the query does not mutate any setting

#### Scenario: User searches by concept
- **WHEN** the user asks for settings related to a concept such as voice, language, or privacy
- **THEN** the agent returns catalog-grounded matches even when the wording does not exactly match a setting label

#### Scenario: Local client settings are not overclaimed
- **WHEN** a gateway catalog query is made before browser-local or Android settings are registered
- **THEN** the result identifies itself as the gateway runtime-profile catalog
- **AND** it does not claim completeness for browser-local controls or Android preferences

### Requirement: Settings mutation cannot invent configuration
The agent SHALL mutate only registered, writable settings through the owning
surface. It SHALL NOT create a new setting, feature flag, storage key, profile
field, or hidden preference as a side effect of an ordinary product request. A
request to add a setting is an explicit product-modification request and SHALL
remain separate from changing an existing setting.

#### Scenario: Registered gateway setting is changed
- **WHEN** the user changes a registered gateway-owned setting
- **THEN** the change uses the gateway profile contract and reports the effective result

#### Scenario: Registered extension-local setting is changed
- **WHEN** the user changes a registered extension-local setting
- **THEN** the gateway or agent returns a typed proposal
- **AND** packaged extension code validates and applies the change locally
- **AND** the extension displays the resulting effective state

#### Scenario: Unknown setting is rejected
- **WHEN** a request names no registered setting and cannot be grounded to one
- **THEN** the agent explains that the setting is unsupported
- **AND** no storage key, profile field, or UI control is created

#### Scenario: Explicit new-setting request remains product work
- **WHEN** the user explicitly asks to add a new setting
- **THEN** the request is routed as implementation or customization work
- **AND** it is not applied as an ad hoc settings mutation
