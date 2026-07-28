# Surface Program Runtime

## ADDED Requirements

### Requirement: A delegated run carries two independently scoped programs

The system SHALL represent remote orchestration and surface-local execution as
separate programs in one versioned envelope. The gateway SHALL run the remote
program in an existing approved agent harness. Only the bound surface SHALL run
the local program.

#### Scenario: Remote program requests a local effect

- **WHEN** remote orchestration needs a browser or phone effect
- **THEN** it proposes a local program and waits for the surface receipt
- **AND** it cannot perform the effect through gateway authority

### Requirement: Effective authority is an intersection

Before every effect, the owning surface SHALL intersect requested grants with
delegation, execution profile, device advertisement, OS permission, current
scope, and local policy. Source, IR, page content, accessibility content, and
remote output SHALL NOT widen authority.

#### Scenario: Source names an ungranted capability

- **WHEN** program source or IR requests a capability absent from any required
  authority input
- **THEN** the surface rejects it before effect and receipts the missing grant

### Requirement: Browser profiles can grant JS/TS and raw CDP

The browser runtime SHALL support inspectable JavaScript and TypeScript-derived
JavaScript. Execution profiles SHALL independently grant worlds, origins,
tabs/documents/frames, browser APIs, and named CDP domains/methods. A profile MAY
grant raw `Runtime.evaluate`; this SHALL NOT be a silent fallback.

#### Scenario: Granted raw CDP runs in a background tab

- **WHEN** a current profile grants `Runtime.evaluate` for a task-owned inactive
  tab and matching origin/document
- **THEN** the extension may attach, evaluate the digest-bound program, return a
  redacted result receipt, and detach at terminal state

#### Scenario: CDP call escapes scope

- **WHEN** a program targets an ungranted tab, origin, frame, or CDP domain
- **THEN** the extension rejects the call without sending it to Chrome

### Requirement: Android executes native-decoded IR

Android SHALL accept a versioned declarative IR and execute implemented,
profile-granted operations through native Java/Kotlin Accessibility and platform
adapters. Android SHALL NOT evaluate generated Java/Kotlin source or bytecode.

#### Scenario: Multi-step accessibility program succeeds

- **WHEN** every IR operation is supported, granted, approved, fresh, and bound
  to the current package/window
- **THEN** Android executes operations in order and emits per-effect plus
  terminal receipts

#### Scenario: State changes during the program

- **WHEN** package, window, observation, permission, approval, or target binding
  becomes invalid before an effect
- **THEN** Android stops before that effect and returns a reason-coded receipt

### Requirement: Leases, cancellation, and receipts converge

Every local program SHALL have a renewable lease, monotonic cancellation state,
idempotent claim/terminal transitions, and canonical receipts bound to the exact
program digest and effective profile. Cancellation or expiry SHALL prevent new
effects and trigger only ownership-proven cleanup.

#### Scenario: Cancellation races with reconnect

- **WHEN** a cancel sequence is persisted while the surface disconnects
- **THEN** reconnect cannot resume an older lease or issue another effect
- **AND** one terminal cancellation receipt describes actual cleanup

### Requirement: Future surfaces declare their native execution contract

macOS, Windows, iOS, and later surfaces SHALL NOT advertise surface-program
support until they define an execution representation/runtime, grants,
unsupported authority, cancellation behavior, and receipt adapter.

#### Scenario: iOS cannot provide requested cross-app control

- **WHEN** an iOS adapter lacks platform authority for a requested operation
- **THEN** it advertises the capability as unsupported rather than emulating or
  inheriting browser/Android authority
