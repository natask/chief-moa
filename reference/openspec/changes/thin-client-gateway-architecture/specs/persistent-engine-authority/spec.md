## ADDED Requirements

### Requirement: Engine is the single execution authority
A persistent engine SHALL be the single authority for model/API calls, secret and
subscription custody, and state persistence. The browser SHALL route meaningful
actions through the engine even when it could make the call directly.

#### Scenario: Meaningful action routes through the engine
- **WHEN** the extension performs a model/API-backed action
- **THEN** the request goes to the engine, which holds the credentials and persists any resulting state, rather than the browser calling the provider as the primary path

#### Scenario: Local direct call is an explicit escape hatch only
- **WHEN** a local browser-only/BYO-key path is used
- **THEN** it is an explicitly chosen developer/fallback mode, not the default route

### Requirement: Hosted or self-hosted, same client
The engine SHALL be runnable hosted (by the project) or self-hosted (by the user),
and the same thin client SHALL work against either by pointing at an engine URL.

#### Scenario: Self-hosted engine
- **WHEN** the user runs their own engine and points the client at its URL
- **THEN** the client works with no client code change, and that engine acts as the user's persistent remote agent
