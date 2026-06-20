## ADDED Requirements

### Requirement: Meaningful action is engine-routed
The proof of this slice SHALL be that the rendered output originated from the
engine, not merely that output rendered — establishing the thin-client → engine
route. The extension SHALL reach the engine for the command and describe paths
rather than acting on its own.

#### Scenario: Reply provenance is the engine
- **WHEN** the overlay renders a command or describe result with a gateway configured
- **THEN** that result demonstrably originated from the engine endpoint (`/v1/voice/turns` or `/v1/chat`), confirming the action was routed through the engine

### Requirement: Command round trip through gateway
The extension SHALL render command replies that originate from the configured
gateway `/v1/voice/turns` endpoint.

#### Scenario: Command reply from gateway
- **WHEN** the user opens the overlay via Cmd+K and submits a command with a gateway configured
- **THEN** the reply rendered in the overlay originates from `/v1/voice/turns`

### Requirement: Describe round trip through gateway
The extension SHALL render page descriptions that originate from the configured
gateway `/v1/chat` endpoint.

#### Scenario: Describe reply from gateway
- **WHEN** the user runs "describe page" with a gateway configured
- **THEN** the description rendered in the overlay originates from `/v1/chat`

### Requirement: Visible gateway failure
The extension SHALL surface gateway connection and authorization failures to the
user rather than failing silently.

#### Scenario: Unreachable or unauthorized gateway
- **WHEN** the gateway is unreachable or rejects the token
- **THEN** a clear error message renders in the overlay
