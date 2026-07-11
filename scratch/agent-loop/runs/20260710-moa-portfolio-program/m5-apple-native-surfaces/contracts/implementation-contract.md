# Apple native surface implementation contract

## Objective

Build an `AggieAppleSurface` Swift package shared by macOS and iOS. It is a
strict local authority adapter for the existing Aggie v2/v1 wire contract, not
a new protocol, backend, database, UI architecture, or production client.

## Owned files

- `apple_surfaces/Package.swift`
- `apple_surfaces/Sources/AggieAppleSurface/**`
- `apple_surfaces/Tests/AggieAppleSurfaceTests/**`
- Apple OpenSpec and workflow packet
- one narrow `ARCHITECTURE.md` section

## Required interfaces

- bounded JSON envelope decoder and N/N-1 negotiation
- canonical `SurfaceIdentity`, proposal, approval and receipt value types
- bounded per-session replay accumulator with exact duplicate acceptance and
  sequence/message conflict rejection
- bounded reconnect full-jitter calculator with injected entropy
- `LocalApprovalPrompt`, `LocalStateProvider`, and `LocalActionExecutor` seams
- actor-isolated `AppleActionCoordinator` that validates, explicitly prompts,
  revalidates state/expiry, invokes the executor at most once, and forms a
  proposal-bound receipt

## Hard behavior

- Maximum envelope 64 KiB; IDs, strings, arrays, nesting and replay retained
  bytes/events are bounded.
- Unknown benign additive fields may be ignored, but unknown semantic types and
  any credential/executable-shaped key or value fail closed before decoding.
- Proposal digest covers version, message/session, complete surface identity,
  timestamp and complete canonical proposal payload.
- Approval is local and binds proposal ID, message ID, digest, complete surface,
  actor and decision time. It cannot cross session, device, mode or surface kind.
- Eligibility is checked again after the prompt against current time and state.
- Duplicate/replayed proposal execution fails closed; denied/failed attempts
  never fabricate an executed receipt.
- Receipts bind proposal, approval, session, complete surface, outcome,
  observation time and a state digest. No raw state/content is persisted.

## Forbidden shortcuts

No URLSession/live networking, provider key, Keychain claim, app executable,
SwiftUI product direction, OS effect implementation, `openURL`, shell/process,
canonical history, global mutable authority, unbounded queue, force unwrap in
authority paths, proposal auto-approval, signing/device/update claim, or mock
presented as production proof.

## Quality/resource gates

- Swift concurrency checks enabled; stateful authority actor-isolated.
- Decision functions target complexity <=10 and CRAP <=15; if no Swift metric
  tool exists, report unmeasured rather than estimate.
- No main-thread blocking or polling; library performs no network/disk I/O.
- Replay max 256 events/1 MiB; pending authority max 128 proposals.
- Tests must assert executor invocation count stays zero on every denial.

## Acceptance commands

Run the commands from the goal. Also inspect the built module for accidental
network, provider, process, or platform-action imports and run hostile audits
for correctness, security/trust, UX/accessibility claims, performance/resource,
quality/complexity, anti-gaming, and integration/protocol drift.

## Audit blockers and escalation

Block on protocol drift, permissive decoding, approval mutation/replay,
time-of-check/time-of-use state gaps, effect invocation before final checks,
unbounded retention, second canonical store, provider credentials, invented UX,
or claims beyond measured evidence. Escalate UX direction, authenticated
transport, Keychain policy, entitlements, signing identities, devices, updates,
distribution, or canonical gateway changes to the parent manager.
