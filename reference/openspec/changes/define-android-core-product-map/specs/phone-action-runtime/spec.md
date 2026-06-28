## ADDED Requirements

### Requirement: Local Authority For Phone Actions
The Android app SHALL remain the authority for phone-local permissions, approvals, execution, and receipts.

#### Scenario: Gateway proposes phone action
- **WHEN** the gateway returns a structured action proposal
- **THEN** the Android app validates the proposal locally before execution

#### Scenario: Proposal is not valid
- **WHEN** the proposed tool is unknown, permission is missing, or the risk level is invalid
- **THEN** the Android app rejects the proposal without executing an action

### Requirement: Static Local Capability Manifest
The Android app SHALL define supported phone-local tools in a local capability manifest.

#### Scenario: Tool is available
- **WHEN** an action references a tool in the local manifest
- **THEN** the app can evaluate its permissions, risk, approval mode, and argument schema

#### Scenario: Tool is absent
- **WHEN** an action references a tool not present in the local manifest
- **THEN** the app refuses the action

#### Scenario: Launcher app listing is available
- **WHEN** the user runs `/apps` or `/list apps`, or a local request references `app.list`
- **THEN** Android lists visible launcher apps from the device-local package manager and records a read-only receipt

#### Scenario: Draft communication tools are available
- **WHEN** a local request references `email.compose` or `sms.compose`
- **THEN** Android opens a draft-only `ACTION_SENDTO` `mailto:` or `smsto:` intent without requesting send/read permissions

### Requirement: Approval Policy
The Android app SHALL require approval based on action risk.

#### Scenario: Read-only screen request
- **WHEN** the user asks to summarize the current screen and screen access is enabled
- **THEN** the app may read screen context without an extra confirmation

#### Scenario: Explicit navigation command
- **WHEN** the user explicitly asks to go back, go home, tap a visible label, or open an installed app
- **THEN** the app may execute that local navigation action and record a receipt

#### Scenario: External side effect
- **WHEN** an action would send, share, submit, call, write, or modify external state
- **THEN** the app requires a local confirmation before execution

#### Scenario: Draft-only communication handoff
- **WHEN** Android opens an email or SMS draft for the user
- **THEN** the target app remains responsible for the final send confirmation and Android records only the draft handoff receipt

#### Scenario: Sensitive side effect
- **WHEN** an action involves money, banking, passwords, security settings, medical, or legal operations
- **THEN** the app blocks the action in the initial product version

### Requirement: Local Action Receipts
Executed phone-local actions SHALL produce local receipts.

#### Scenario: Action succeeds
- **WHEN** the app executes a phone-local action
- **THEN** it writes a local receipt with tool, risk, approval, target context, result, timestamp, and previous receipt hash

#### Scenario: Action fails
- **WHEN** the app attempts a phone-local action and it fails
- **THEN** it writes a local receipt describing the failed result
