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
