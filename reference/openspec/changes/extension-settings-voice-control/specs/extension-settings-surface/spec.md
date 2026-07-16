## ADDED Requirements

### Requirement: Extension settings surface
The extension SHALL present its thin-client configuration — engine URL/session
token and engine-owned runtime profile fields including system prompt and model
selection — in a settings surface that shows the values currently in effect. It
SHALL NOT present provider API keys or subscriptions as browser-owned settings.

#### Scenario: Settings reflect current state
- **WHEN** the settings surface loads with a reachable gateway
- **THEN** it shows the current engine connection config and the effective agent profile from `GET /v1/agent/profile`

### Requirement: Settings stay in sync with the gateway
The settings surface SHALL stay consistent with the gateway runtime profile so a
change made elsewhere is reflected.

#### Scenario: External change reflected
- **WHEN** the agent profile changes (e.g. via the agent) and the surface refreshes
- **THEN** the displayed settings match the new effective profile

### Requirement: Search-first visual settings projection
After the browser-local catalog merge is implemented, the extension SHALL
project the merged registered settings catalog into a
searchable, Command-K-style command or workspace surface usable with typed
command and voice input. Results SHALL use bounded packaged UI showing the
setting name, current value or redacted state, explanation, and allowed choices.
An allowed deep link or change action SHALL be explicit rather than inferred
from selecting a row. The full Options page SHALL remain the deep
configuration and Chrome permission surface rather than the primary discovery
path.

The implemented browser slice covers typed and finalized-spoken projections with
matching ids/current values, bounded complete `All`, grounded search and
recommendation, selectable side-panel rows, Cmd/Ctrl+K focus, and owner-brokered
writes. Browser-side compare remains staged. Neither the gateway catalog nor
this browser projection SHALL be treated as evidence that an Android settings
registry exists.

#### Scenario: Typed search renders selectable settings
- **WHEN** the user types a settings query in the command or workspace surface
- **THEN** the extension shows selectable setting rows with current effective values and grounded descriptions

#### Scenario: Voice and typed discovery share results
- **WHEN** the user asks the same settings question by voice
- **THEN** the extension projects the same catalog result identities and effective values as the typed path

#### Scenario: Deep configuration focuses the selected control
- **WHEN** a selected result requires the Options page or a Chrome permission gesture
- **THEN** the extension opens the Options page focused on the relevant control
- **AND** the agent explains the visible recovery step
- **AND** the agent does not claim it can grant the Chrome permission itself
