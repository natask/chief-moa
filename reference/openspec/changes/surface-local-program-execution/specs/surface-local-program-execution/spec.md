# Surface-Local Program Execution Specification

## ADDED Requirements

### Requirement: Surfaces advertise bounded local program runtimes

Each executable surface SHALL advertise a versioned runtime profile and an
exact local capability catalog. The advertisement SHALL identify the target
device and surface, scripting language, runtime profile, bridge version,
catalog version and digest, resource limits, issue time, and expiry. An
advertisement is availability evidence and SHALL NOT grant permission or
execution authority.

#### Scenario: Model targets an advertised browser runtime

- **WHEN** a fresh browser advertises `browser.javascript.v1` and a catalog
  containing the required local capabilities
- **THEN** the gateway may create a browser-targeted program proposal against
  that exact profile and catalog snapshot
- **AND** no primitive browser call executes at proposal time

#### Scenario: Runtime advertisement expires

- **WHEN** the selected runtime advertisement expires before acceptance
- **THEN** the owning surface rejects the proposal without starting a program

### Requirement: One remote proposal may compose many local calls

The primary delegated-execution unit SHALL be one bounded program delivered to
one target surface. Calls made by that program to capabilities owned by the
same surface SHALL execute through the local bridge without a gateway or model
round trip per primitive call. The program MAY branch, validate intermediate
results, retry safe alternatives, and run compatible reads concurrently within
its declared and locally enforced budgets.

#### Scenario: Browser program handles alternative controls

- **WHEN** a browser program observes a fixture page, tries bounded alternative
  controls, and validates the resulting state
- **THEN** those observe/query/action calls execute locally in one program run
- **AND** only proposal delivery and bounded lifecycle/receipt synchronization
  cross the gateway boundary

#### Scenario: Local program requests another surface

- **WHEN** a browser program needs an Android-owned action
- **THEN** that request becomes a separately routed Android proposal
- **AND** it does not inherit the browser program's target, permission, or
  approval

### Requirement: Each surface selects an appropriate scripting profile

The common wire contract SHALL describe a program and runtime profile without
requiring one implementation language for every surface. Browser SHALL support
a packaged local JavaScript orchestration profile; Android SHALL support a
dedicated non-visible WebView JavaScript profile bridged primarily to Android
Accessibility; macOS SHALL support a JavaScriptCore profile bridged to public
Accessibility operations. JXA, AppleScript, and shell SHALL be separate macOS
profiles with independent installation, allowlists, grants, approvals, limits,
and receipts. Gateway QuickJS SHALL expose only gateway-owned capabilities.

#### Scenario: Android receives JavaScript

- **WHEN** Android accepts a proposal for `android.webview-js.v1`
- **THEN** it executes JavaScript directly in a fresh dedicated WebView realm
- **AND** does not transpile the program to Java or expose Java reflection,
  arbitrary network, user WebView state, or unrestricted bridge objects

#### Scenario: macOS AX profile is enabled without shell

- **WHEN** macOS advertises `macos.javascriptcore-ax.v1` but no shell profile
- **THEN** the program can call only the advertised public AX bridge functions
- **AND** cannot invoke a subprocess, Apple Event, Keychain, or filesystem
  operation by inheritance

### Requirement: Android execution is Accessibility-first

Android cross-application observation and control SHALL run through the local
`AccessibilityService` adapter. Accessibility observations SHALL use bounded,
short-lived node handles tied to package, window, observation generation, and
state evidence. The client SHALL revalidate those bindings immediately before
every effect. Intents MAY handle app launch, URLs, and safe platform handoffs
but SHALL NOT substitute for current-screen validation.

#### Scenario: Accessibility node remains current

- **WHEN** a program clicks a supported node whose package, window, generation,
  role, fingerprint, and actionability still match its observation
- **THEN** Android may perform the Accessibility action under local policy
- **AND** records the tool attempt before resolving the program call

#### Scenario: Foreground app changes

- **WHEN** the foreground package or bound window changes after observation
- **THEN** Android rejects the attempted action as `stale_state`
- **AND** performs no tap or synthetic-coordinate fallback

### Requirement: Browser orchestration and page execution remain distinct

Browser program source SHALL execute in an extension-owned sandboxed runtime
with an immutable local tools namespace and no raw privileged extension
globals. DOM helpers, tab operations, keyboard input, screenshots, and bounded
CDP operations SHALL be packaged adapters. Page evaluation or persistent
userscript execution SHALL require a separately advertised capability and a
fresh binding to tab, frame, origin, document epoch, execution world, and local
site grant.

#### Scenario: Program inspects a fixture page

- **WHEN** a browser program calls packaged observation and DOM-query adapters
- **THEN** the extension executes them against only the bound fixture tab
- **AND** does not release cookies, authorization headers, passwords, or
  browser storage to the gateway, model, trace, or receipt

#### Scenario: Program lacks page-evaluation capability

- **WHEN** source attempts page evaluation but the immutable catalog snapshot
  omits that capability
- **THEN** the local bridge rejects the call without evaluating the source in
  the page

### Requirement: Program proposals are closed, bound, and one-shot

`surface.execution.proposed` SHALL be a closed semantic envelope distinct from
legacy action proposals. It SHALL bind execution, session, turn, exact target,
runtime, source digest, catalog subset and digest, surface state, limits,
approval policy, one-shot idempotency key, issue time, and expiry. The owning
surface SHALL validate all bindings and durably record acceptance before any
effect. Legacy action proposal decoders SHALL continue rejecting executable or
command-shaped fields. Every SHA-256 value SHALL be exactly 64 lowercase
hexadecimal characters without a `sha256:` prefix and SHALL cover the canonical
protocol bytes defined for that field.

#### Scenario: Source changes after approval

- **WHEN** program bytes do not match the proposal's source digest
- **THEN** the surface rejects the proposal without starting the runtime

#### Scenario: Program is hidden in legacy action parameters

- **WHEN** an action proposal contains `script`, `javascript`, `code`, `shell`,
  or an equivalent executable field
- **THEN** the legacy decoder rejects it
- **AND** does not reinterpret it as a surface program

#### Scenario: Accepted execution is replayed

- **WHEN** an already consumed execution ID or idempotency key is submitted
  again
- **THEN** the surface returns the recorded outcome or rejects the replay
- **AND** performs no duplicate effect

### Requirement: Local policy governs every host call

The runtime SHALL receive only immutable advertised functions, bounded
progress/result channels, and cancellation state. Every host call SHALL
revalidate schema, catalog membership, current state, grant, effect class,
approval, concurrency, and idempotency locally. Read-only calls MAY run in
parallel. Externally visible, destructive, security-sensitive, financial,
publishing, sending, or otherwise irreversible effects SHALL NOT be executed
speculatively or duplicated for fallback.

#### Scenario: Parallel reads fit the budget

- **WHEN** a program launches compatible read-only observations within its
  parallel-call limit
- **THEN** the local scheduler may run them concurrently
- **AND** records each attempted call

#### Scenario: Alternative strategy would duplicate a send

- **WHEN** a failed validation path would retry an externally visible send
- **THEN** the scheduler stops before a second effect
- **AND** requires an effect-specific idempotency decision or renewed local
  approval

### Requirement: Checkpoints do not imply arbitrary rollback

A checkpoint SHALL be observation evidence unless a specific local adapter
advertises and verifies a real restore operation. The runtime SHALL NOT claim
that history navigation, DOM reconstruction, Accessibility actions, AX actions,
page scripts, shell commands, or external API effects were rolled back merely
because a prior checkpoint exists.

#### Scenario: Disposable fixture tab is restored

- **WHEN** a browser adapter owns a disposable fixture tab and supplies a
  tested restore operation for it
- **THEN** the program may use and receipt that explicit restore capability

#### Scenario: External effect has no inverse

- **WHEN** cleanup cannot prove that an external effect was reversed
- **THEN** the receipt reports `not_reversible` or `indeterminate`
- **AND** does not report successful backtracking

### Requirement: Every attempt and termination is locally receipted

The owning surface SHALL produce a bounded receipt for every attempted host
call and one terminal receipt for every accepted or rejected program. Receipts
SHALL bind claimant, program, catalog, state bindings, inputs, approval where
applicable, timestamps, status, and receipt-chain evidence. They SHALL omit raw
screenshots, page bodies, Accessibility/AX trees, form values, stdout/stderr
dumps, environment contents, credentials, and browser session material.

#### Scenario: User stops a running program

- **WHEN** the local stop control is activated
- **THEN** the runtime prevents new host calls immediately
- **AND** cancels only operations that are locally cancellable
- **AND** records `stopped` or `indeterminate` without claiming an in-flight
  external effect was reversed

#### Scenario: Durable pending record fails

- **WHEN** the surface cannot durably record acceptance or pending effect state
- **THEN** execution does not begin
- **AND** a bounded rejection outcome is returned

### Requirement: QA and release never consume personal surface state

Automated QA SHALL use isolated fixture origins, synthetic accounts, disposable
browser profiles, fixture APK/emulator data, dedicated macOS test identities or
VMs, isolated server stores, and separate artifact paths. It SHALL NOT capture,
serialize, upload, package, deploy, or modify the user's active page, daily
browser profile, foreground desktop session, or unrelated Android app data.
Build, package, install, smoke, and active-promotion evidence SHALL remain
distinct.

#### Scenario: Browser automation tests run

- **WHEN** the browser execution lane runs automated QA
- **THEN** it targets only declared fixture tabs in a disposable profile
- **AND** test artifacts contain no unrelated tab content or personal capture

#### Scenario: Artifact is built without safe installation evidence

- **WHEN** a browser package, Android APK, or unsigned macOS bundle exists but
  signing, rollback, compatibility, no-interruption, or isolated runtime smoke
  evidence is missing
- **THEN** the lane records only the evidenced build/package state
- **AND** does not install or actively promote it

### Requirement: New executable modules meet focused coverage gates

The implementation SHALL require each new executable source module introduced
for surface-local program execution to exceed 90 percent line coverage and 90
percent branch coverage after behavior tests. Coverage SHALL be evaluated per
new module; generated
bindings, declarative schemas, unrelated code, and repository-wide aggregation
SHALL NOT dilute the gate. Closed-schema adversarial tests SHALL cover unknown
types and fields, stale state, replay, catalog drift, forged receipts, profile
escalation, limit enforcement, interruption, and sensitive-data omission.

#### Scenario: Aggregate coverage exceeds 90 but one runtime module does not

- **WHEN** repository or package aggregate coverage exceeds 90 percent while a
  new executable runtime module is at or below 90 percent for lines or branches
- **THEN** verification fails for that implementation unit

#### Scenario: Fixture behavior and adversarial suites pass

- **WHEN** a candidate passes isolated behavior tests, adversarial contract
  tests, and per-module line and branch thresholds
- **THEN** the exact clean candidate may proceed to its surface-specific
  package or preview gate
