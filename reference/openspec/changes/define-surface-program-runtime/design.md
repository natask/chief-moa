# Surface Program Runtime Design

## Decision

A delegated run has one signed/versioned `surface_program.v1` envelope carrying
two independently scoped programs:

```text
user intent
  -> gateway resolves profile and creates envelope
  -> remote program runs in the existing agent harness
  -> local program is claimed by the bound surface
  -> owning surface intersects requested grants with current local grants
  -> execute under lease; emit events and effect receipts
  -> cancel, complete, fail, or expire to one terminal receipt
```

The remote program plans, calls gateway/external tools, waits for local
receipts, evaluates completion, and coordinates retries. It cannot directly
operate a browser or phone. The local program composes operations inside the
surface that owns the relevant OS/application authority.

## Envelope

Required fields include `program_id`, `revision`, `run_id`, `task_id`,
`principal`, `surface`, `device_id`, `execution_profile_id`, `profile_revision`,
`remote_program`, `local_program`, requested `grants`, exact `scope`, `limits`,
`lease`, `approval`, `issued_at`, `expires_at`, and content digests. Scope can
bind origin, tab, document/frame, package, window, observation, project, and
account connection as applicable. Unknown versions and fields fail closed.

The effective grant is the intersection of the proposal, gateway delegation,
device advertisement, stored user/admin profile, current OS permission, and
current surface policy. No program can add a grant by naming it in source or IR.

## Remote program

The gateway reuses its existing harness launcher, run store, cancellation, and
evidence model. The envelope selects a checked-in launcher profile and bounded
context pack. It never supplies arbitrary host paths, raw environment content,
or provider credentials to the surface. Durable orchestration may resume after
a process restart, but each resumed local effect requires a fresh lease and
state validation.

## Browser program

JavaScript is the native browser composition language. TypeScript is accepted
only after deterministic local or gateway compilation to inspectable JavaScript;
the receipt binds both source and emitted digests. Execution is never string
injection into the extension service worker.

Profiles independently grant:

- tab lifecycle and selection, including inactive/background creation;
- isolated-world or main-world execution and allowed origins/frames;
- DOM read/write and network-observation classes;
- named CDP domains and methods, including raw `Runtime.evaluate`;
- download/upload, clipboard, or other browser privileges when implemented;
- duration, step, CPU, memory, output, navigation, and tab-count limits.

`Runtime.evaluate` is a first-class granted capability. It is not a fallback for
missing semantic tools. The extension attaches the debugger only to a bound tab,
filters each method against the effective profile, revalidates tab/document and
origin before state-changing calls, redacts credentials and sensitive results,
and detaches on cancellation or terminal state. A broad developer profile may
grant multiple CDP domains and origins; its breadth is visible and revocable.

Background runs create inactive tabs and hold renewable ownership leases. They
may modify and close tabs they own. Touching a pre-existing tab requires a
separate grant. Cancellation stops new calls, interrupts the runner where
possible, detaches CDP, and closes only task-owned tabs whose ownership is still
unambiguous.

## Android program

Android local programs are `android_ir.v1`, a bounded data representation that
the native app validates and interprets. Initial operations cover observation,
semantic node query/reference, click, long-click, set text, scroll, global
actions, bounded gestures, application/URL/intent launch through checked native
adapters, wait-for-state, branching, bounded loops, assertion, and receipt
emission. Each operation declares required grants and risk.

The interpreter binds package, window, observation, target references, and
freshness where applicable. It checks Accessibility/OS permission and local
approval immediately before effects. Passwords and sensitive fields have local
policy independent of program grants. Cancellation is checked between
operations, during waits, and before every effect. Java/Kotlin remains the
implementation language of the interpreter, not model-authored executable input.

## Lifecycle and receipts

Lifecycle is `proposed -> approved|denied -> leased -> running ->
completed|failed|cancelled|expired`. Claim and terminal transitions are
idempotent. Every effect receipt binds program/revision/digest, run/task,
surface/device, profile revision, effective grants, scope snapshot, operation
index, before/after evidence references, timestamps, result, and redactions.
Receipts never contain cookies, auth headers, password values, or raw secrets.

Cancel is an authenticated request with a monotonic sequence. The gateway and
surface both retain it so reconnecting clients cannot resume an older lease.
Expiry is cancellation by policy, not successful completion. Cleanup receipts
state what was actually detached, closed, reverted, or left in place; execution
does not claim arbitrary side effects were rolled back.

## Surface matrix

| Surface | Local representation/runtime | Privileged adapters | Initial status |
|---|---|---|---|
| Browser | JS/TS to inspectable JS in isolated runner | extension APIs, DOM worlds, profile-granted raw CDP | implement first |
| Android | `android_ir.v1` in native Java/Kotlin interpreter | Accessibility, intents, media/device APIs | implement first |
| macOS | Swift/native IR or JavaScriptCore profile, selected by prototype | Accessibility, ScreenCaptureKit, App Intents | design seam |
| Windows | .NET/native IR or approved scripting host | UI Automation, WinRT, PowerShell broker | design seam |
| iOS | constrained native IR | App Intents, Shortcuts, document/UI owned APIs | design seam; no arbitrary cross-app claim |
| Gateway/execution machine | existing agent harness | registered server/external/repo tools | reuse |

Each future surface must document its execution language, isolation primitive,
grant vocabulary, unsupported authority, cancellation guarantees, and receipt
adapter before advertising program support.

## Rollout

Land the envelope/profile/lifecycle contract first. Then implement browser and
Android adapters independently behind default-deny profiles. Add visible profile
management and revocation before enabling broad grants. Verify exact artifacts
on real surfaces. Promotion follows the repository active-promotion gate; a
package, OTA publication, or reload signal is not installation/smoke evidence.
