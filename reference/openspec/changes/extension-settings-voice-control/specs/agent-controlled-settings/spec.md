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
The merged browser/gateway settings catalog SHALL contain one stable entry for
every canonical gateway runtime-profile setting and every registered
browser-local setting. Each entry contains its key, owning scope, current
effective value, default, description, allowed values or constraints, and
mutability. The user SHALL be able to ask through typed or finalized browser
voice input to list, get, search, and recommend the merged settings. Search MAY
use semantic ranking, but every result SHALL be grounded in a catalog entry and
identify the effective value.

This merged browser/gateway catalog SHALL NOT claim to enumerate Android
preferences. Android settings remain owned by the Android client.

Secrets such as the gateway session token SHALL be represented only by bounded
redacted state and SHALL NOT be returned as catalog values.

#### Scenario: User asks for all settings
- **WHEN** the user asks through typed or finalized browser voice input what settings are available
- **THEN** the extension returns the complete bounded set of registered browser-local settings and reachable gateway-owned settings
- **AND** each returned setting identifies its current effective value or a redacted configured/unconfigured state

#### Scenario: User searches by desired outcome
- **WHEN** the user asks which settings would help with an outcome without naming an exact setting label
- **THEN** the agent returns ranked matching catalog entries with their effective values and grounded explanations
- **AND** the query does not mutate any setting

#### Scenario: User searches by concept
- **WHEN** the user asks for settings related to a concept such as voice, language, or privacy
- **THEN** the agent returns catalog-grounded matches even when the wording does not exactly match a setting label

#### Scenario: Android settings are not overclaimed
- **WHEN** the merged browser/gateway catalog is listed or searched
- **THEN** it identifies browser-local and gateway-owned settings by owner
- **AND** it does not claim completeness for Android preferences

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
- **THEN** the extension routes the request to the browser-local settings owner
- **AND** packaged extension code validates writability, value, and any required approval before applying it
- **AND** the extension returns a bounded receipt containing the resulting effective or redacted state

#### Scenario: Protected local setting fails closed
- **WHEN** a request tries to write microphone permission or enable background automation without its required user action or versioned approval
- **THEN** the extension rejects the write without changing stored state

#### Scenario: Unknown setting is rejected
- **WHEN** a request names no registered setting and cannot be grounded to one
- **THEN** the agent explains that the setting is unsupported
- **AND** no storage key, profile field, or UI control is created

#### Scenario: Explicit new-setting request remains product work
- **WHEN** the user explicitly asks to add a new setting
- **THEN** the request is routed as implementation or customization work
- **AND** it is not applied as an ad hoc settings mutation
