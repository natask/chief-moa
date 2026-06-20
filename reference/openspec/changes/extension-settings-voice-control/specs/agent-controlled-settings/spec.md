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
