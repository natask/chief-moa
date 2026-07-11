# Apple native Aggie surface specification

## ADDED Requirements

### Requirement: Apple clients preserve local action authority

The shared Apple adapter SHALL treat every server/model action as an untrusted,
bounded Aggie N/N-1 proposal. It SHALL require matching session and complete
surface identity, explicit local approval bound to the complete proposal, and a
fresh local-state and expiry check immediately before any injected effect.

#### Scenario: Local state changes while approval is shown

- **WHEN** proposal preconditions no longer match after approval
- **THEN** the adapter rejects the action and never invokes the executor

#### Scenario: Approval crosses Apple device or mode

- **WHEN** an approval surface differs in ID, kind, mode, or device-ID presence/value
- **THEN** the adapter rejects it and emits no executed receipt

### Requirement: Apple protocol state is bounded and non-canonical

The Apple adapter SHALL enforce hard bounds for envelopes, nesting, arrays,
replay history, pending proposals and reconnect delay. It SHALL reject executable or credential-shaped
authority even in unknown additive fields. It SHALL perform no network,
provider, OS action, signing or canonical-history operation. Its only durable
write authority is a bounded local effect journal used to prevent retry after a
crash or uncertain executor result.

#### Scenario: Additive credential field arrives

- **WHEN** an otherwise unknown field carries token or executable authority
- **THEN** decoding fails closed before approval or execution

### Requirement: Apple effects recover conservatively across restart

The Apple adapter SHALL durably record the effect boundary before invoking a
local executor. A restart or untyped executor failure after that boundary SHALL
recover as `unknown_effect`, prevent automatic retry, and direct the product
surface to request user verification. Closed protocol enums and finite,
JavaScript-safe canonical numbers SHALL fail before approval when unknown or
ambiguous.

#### Scenario: Process stops across the effect boundary

- **WHEN** the adapter restarts without a typed terminal executor result
- **THEN** the proposal remains consumed as `unknown_effect` and cannot run again
