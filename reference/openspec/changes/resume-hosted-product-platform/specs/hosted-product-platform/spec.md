# Hosted product platform

## ADDED Requirements

### Requirement: BYO Model Credential Resolution Order

The gateway SHALL resolve an authenticated user's connected provider
credential for a model call before falling back to the deployment-wide
operator credential. The operator credential SHALL remain the fallback when
no user connection exists. The raw credential SHALL never appear in a client
response, log, or model context.

#### Scenario: User with a connected account

- **WHEN** an authenticated user has a connected provider account for the
  provider a model call targets
- **THEN** the gateway uses that user's decrypted credential for the call,
  verified via the provider request's credential source
- **AND** the raw credential does not appear in any log line or client
  response

#### Scenario: User with no connected account

- **WHEN** an authenticated user has no connected account for the targeted
  provider
- **THEN** the gateway falls back to the deployment's operator credential,
  unchanged from current behavior

#### Scenario: Self-host operator deployment

- **WHEN** a deployment is configured with a self-host operator credential
  policy and any user makes a model call
- **THEN** the gateway uses the single operator credential regardless of any
  connected account, matching the self-host single-tenant model
