# Design: Surface-Local Program Execution

## Selected Model

The expensive remote operation is program generation and delivery. Primitive
tool calls stay inside the selected client:

```text
surface advertises runtime profile + local capability manifest
  -> gateway resolves a target but does not execute
  -> model produces one program against the exact advertised signatures
  -> gateway creates an inert, bound surface.execution.proposed record
  -> owning surface revalidates target, runtime, catalog, scope, state, expiry,
     grant, approval, limits, and source digest
  -> local runtime invokes many local host functions
  -> reads may run concurrently; code may branch and try safe alternatives
  -> local policy pauses or rejects at sensitive effects
  -> owning surface records tool-attempt and terminal receipts
  -> bounded events/receipts sync to the gateway
```

The program never turns the gateway into a remote DOM, Accessibility, or desktop
RPC loop. Cross-surface calls requested by a running program remain explicit
gateway-routed proposals to the other owning surface; they are not local calls
and cannot inherit the current program's approval.

## Runtime Profiles

| Surface/profile | Program host | Local bridge | Deliberately absent |
| --- | --- | --- | --- |
| Browser `browser.javascript.v1` | Extension-owned sandboxed JavaScript worker/runtime | Packaged tab, DOM, keyboard, screenshot, CDP, anchor, and userscript adapters | Raw `chrome.*`, provider keys, extension storage, service-worker globals |
| Android `android.webview-js.v1` | Dedicated non-visible WebView worker with a fresh execution realm | Java/Kotlin broker over `AccessibilityService`, safe intents, app state, and optional screenshot | Reflection, arbitrary bridge object graphs, raw filesystem/network, provider keys |
| macOS `macos.javascriptcore-ax.v1` | Per-program `JSContext`/JavaScriptCore realm | Swift bridge over public `AXUIElement`/`AXObserver`, scoped app state, and separately granted focused-window capture | Keychain, arbitrary Objective-C/Swift access, Apple Events, shell, provider keys |
| macOS `macos.jxa.v1` | Bound `osascript` JXA subprocess | Explicit Apple Events target/suite allowlist | Ambient AX, shell, Keychain, unrestricted target set |
| macOS `macos.applescript.v1` | Bound `osascript` AppleScript subprocess | Explicit Apple Events target/suite allowlist | Ambient AX, shell, Keychain, unrestricted target set |
| macOS `macos.shell.v1` | Bounded subprocess profile | Command/argument or script policy, cwd/filesystem/network allowlists | Accessibility or Apple Events by inheritance, login shell, host environment dump |
| Gateway `gateway.quickjs.v1` | Existing bounded QuickJS/WASM | Gateway-owned API, storage, routing, connector, and run functions | DOM, Android Accessibility, macOS AX/TCC, browser session credentials |

The browser program host is separate from page execution. When the program
calls the explicitly advertised `page.evaluate` or persistent userscript
capability, the packaged adapter creates a separately bound user-script
execution using the selected tab/frame/world/site grant. Generated orchestration
source does not run as privileged extension service-worker code. Packaged typed
click/fill/snapshot helpers and CDP remain efficient adapters behind the same
local runtime.

Android uses JavaScript because a WebView already supplies a maintained V8 host;
there is no transpiler. The runtime WebView has no user navigation, browsing
history, cookies, autofill, file access, or arbitrary network load. A narrow
message transport marshals calls to a Java/Kotlin broker. The broker performs
Accessibility operations on the required Android thread and resolves the
program promise with a bounded result. Cross-app observation and control are
Accessibility-first; intents are used for app launch, URLs, and safe platform
handoffs, not as a replacement for screen-state validation.

The default macOS profile uses JavaScriptCore because it embeds directly in the
native client and can receive a narrow Swift bridge. JXA and AppleScript use
Apple Events and therefore have materially different consent, target, and
audit requirements. Shell has broader process/filesystem/network implications.
They are separate runtime profile IDs with separate installation state,
capability catalogs, approval UX, limits, and receipts. Enabling one never adds
its powers to another.

## Closed Wire Contract

All maps below are closed: unknown fields fail validation. No general
`extensions` bag exists on authority-bearing records. Protocol N/N-1
negotiation remains required, and additive evolution occurs only through a new
negotiated version.

Every SHA-256 field uses exactly 64 lowercase hexadecimal characters with no
`sha256:` prefix. Hash input is the protocol's canonical byte representation,
never a platform's incidental map ordering or display serialization.

### Runtime advertisement

The device-client heartbeat may include a closed runtime advertisement:

```json
{
  "version": 1,
  "type": "surface.runtime.advertised",
  "advertisement_id": "sra_uuid",
  "target": { "surface_type": "browser", "device_id": "device_uuid" },
  "runtime": { "runtime_id": "browser.javascript.v1", "language": "javascript", "bridge_version": 1, "entrypoint": "main" },
  "catalog": { "version": 7, "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "capability_ids": [] },
  "limits": { "source_bytes": 65536, "wall_ms": 30000, "memory_bytes": 33554432, "tool_calls": 100, "parallel_calls": 8, "result_bytes": 65536, "log_bytes": 32768 },
  "issued_at": "RFC3339",
  "expires_at": "RFC3339"
}
```

Capability signatures remain in the existing local manifest/catalog. Each
descriptor has an exact input/output schema, effect class, approval class,
idempotency behavior, concurrency policy, and optional real restore capability.
Descriptions and schemas are inert data; they cannot install implementations.
A capability snapshot is usable only while the advertisement and current local
implementation both remain present.

### Normative program proposal

The shared semantic record has this exact core:

```json
{
  "version": 1,
  "type": "surface.execution.proposed",
  "execution_id": "exec_uuid",
  "session_id": "session_uuid",
  "turn_id": "turn_uuid",
  "target": { "surface_type": "android", "device_id": "device_uuid" },
  "runtime": { "runtime_id": "android.webview-js.v1", "language": "javascript", "bridge_version": 1, "entrypoint": "main" },
  "program": { "source": "...", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
  "catalog": { "version": 7, "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "allowed_capability_ids": [] },
  "bindings": { "kind": "android_accessibility", "observation_id": "obs_uuid", "state_sha256": "0000000000000000000000000000000000000000000000000000000000000000", "package_name": "com.example.fixture", "window_id": "window_uuid" },
  "limits": { "source_bytes": 65536, "wall_ms": 30000, "memory_bytes": 33554432, "tool_calls": 100, "parallel_calls": 8, "result_bytes": 65536, "log_bytes": 32768 },
  "approval_policy": { "program": "preauthorized", "always_ask": [] },
  "idempotency_key": "idem_uuid",
  "issued_at": "RFC3339",
  "expires_at": "RFC3339"
}
```

`bindings` is a closed discriminated union:

- `browser_document`: tab, frame, origin, document/page epoch, observation and
  state digests, plus execution world/site grant when page evaluation is used.
- `android_accessibility`: package, window, observation generation/state digest,
  and any locally scoped app/grant identity.
- `macos_accessibility`: bundle, PID/process generation, signing identity,
  window, AX snapshot/state digest, and local grant.
- `macos_apple_events`: exact target bundle/signing identity, Apple Events
  suite/command allowlist, local grant, and state digest.
- `macos_shell`: executable/script policy ID, argument digest, cwd/filesystem/
  network profile IDs, environment digest, and local grant.
- `gateway_server`: tenant/project/connection or server-resource bindings for
  gateway-owned QuickJS work only.

`program.source` must match `program.sha256`; runtime language and entrypoint
must match the advertised profile. Catalog `allowed_capability_ids` is the exact
immutable subset offered to the program. The canonical proposal digest covers
the entire record. `execution_id` and `idempotency_key` are one-shot within the
bound target; a replacement proposal gets new values and approval even when the
source is identical.

During V0 migration, the exact-target device hub may transport this record as
the argument of `surface.program.execute`. That tool request is only transport:
the enclosed `surface.execution.proposed` record remains the first-class
semantic proposal, and the target client must apply the same decoder,
validation, event, and receipt rules. The gateway may not retarget it.

This record is not an `action_proposal` variant. Legacy action proposal decoders
keep their existing executable-field denylist. A program placed in action
parameters, unknown additive fields, or context is rejected.

### Lifecycle event

```json
{
  "version": 1,
  "type": "surface.execution.event",
  "event_id": "event_uuid",
  "execution_id": "exec_uuid",
  "sequence": 1,
  "kind": "accepted|started|tool_started|tool_finished|approval_required|approval_resolved|progress|stopping|terminal",
  "occurred_at": "RFC3339",
  "claimant": { "surface_type": "android", "device_id": "device_uuid", "client_instance_id": "client_uuid" },
  "payload": {}
}
```

`payload` is a closed discriminated union selected by `kind`, not an arbitrary
bag. It contains only the fields for that kind: bounded progress; approval
handle/effect class; capability ID, call ID and attempt; or terminal status and
receipt ID. Unknown kinds, fields, or kind/payload mismatches fail. Exact
duplicates are idempotent; gaps, reordering, conflicting IDs, or a different
claimant require reconciliation.

### Tool-attempt and terminal receipts

```json
{
  "version": 1,
  "type": "surface.execution.tool_receipt",
  "receipt_id": "tool_receipt_uuid",
  "execution_id": "exec_uuid",
  "claimant": { "surface_type": "android", "device_id": "device_uuid", "client_instance_id": "client_uuid" },
  "tool_call_id": "call_uuid",
  "attempt": 1,
  "capability_id": "android.accessibility.click",
  "program_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "catalog_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "bindings_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "input_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "pre_state_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "approval_id": null,
  "started_at": "RFC3339",
  "finished_at": "RFC3339",
  "status": "succeeded|failed|rejected|stale_state|timed_out|stopped|indeterminate",
  "result": { "summary": "bounded", "data_sha256": null, "resource_id": null },
  "post_state_sha256": null,
  "previous_receipt_sha256": null,
  "receipt_sha256": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

```json
{
  "version": 1,
  "type": "surface.execution.receipt",
  "receipt_id": "receipt_uuid",
  "execution_id": "exec_uuid",
  "session_id": "session_uuid",
  "turn_id": "turn_uuid",
  "claimant": { "surface_type": "android", "device_id": "device_uuid", "client_instance_id": "client_uuid" },
  "runtime_id": "android.webview-js.v1",
  "program_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "catalog_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "bindings_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "started_at": null,
  "finished_at": "RFC3339",
  "status": "rejected|completed|failed|timed_out|stopped|interrupted|indeterminate",
  "tool_attempts": { "count": 3, "first_receipt_sha256": null, "last_receipt_sha256": null },
  "result": { "summary": "bounded", "data_sha256": null, "artifact_refs": [] },
  "final_state_sha256": null,
  "error": { "code": null, "message": null },
  "previous_receipt_sha256": null,
  "receipt_sha256": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

Receipts bind the claimant and the program, catalog, and bindings digests.
They contain digests and bounded summaries, not raw screenshots, page bodies,
Accessibility trees, form values, stdout/stderr dumps, environment, or
credentials. Bulk evidence uses separately authorized encrypted artifacts.
Receipt chains are correlation/integrity evidence, not remote attestation.

## Local Execution Semantics

Before accepting, the client verifies authentication, exact target/claimant,
advertisement freshness, profile availability, source digest, catalog digest,
limits not exceeding local maxima, bindings/state, grant, approval policy,
expiry, and one-shot idempotency key. It durably records acceptance/pending state
before any effect. If durable recording fails, execution does not start.

The runtime receives a fresh realm, immutable `tools` namespace, bounded
progress/log functions, abort signal, and result function. It receives no
ambient host objects. Each bridge call validates schema and capability
membership again, records `tool_started`, applies effect-specific approval and
idempotency, runs locally, records the attempt receipt, then resolves or rejects
the program promise. Tool errors are values/errors the program may handle;
policy rejection cannot be caught and converted into authority.

Read-only calls may run under `Promise.all` up to `parallel_calls`. The scheduler
serializes conflicting writes by resource. Multiple strategies may use separate
disposable tabs, fixture documents, or adapter-provided transactions. A program
cannot mark an external effect speculative. Send, publish, purchase, account or
security change, delete, and other irreversible effects require a local
checkpoint and idempotency key and are never duplicated automatically.

Cancellation is cooperative at bridge boundaries and preemptive at runtime
limits. Stop prevents new host calls immediately, cancels cancellable local
operations, and records `stopped` or `indeterminate`; it does not assert that an
in-flight external system reversed an accepted request.

## State, Checkpoints, And Honest Recovery

`observe` returns short-lived local handles plus an observation/state digest.
Every effect revalidates handles and bound identity immediately before acting.
Browser anchors bind tab/frame/document/page epoch; Android nodes bind window,
package, node fingerprint, and observation generation; macOS elements bind
bundle, PID/process generation, signing identity, window, element fingerprint,
and AX snapshot.

A checkpoint records evidence. `restore(checkpoint)` is offered only when the
adapter implements a real, tested inverse for the affected resource. Safe uses
include a disposable browser tab or an adapter-owned temporary document.
History navigation, DOM reconstruction, AX actions, generated page scripts,
shell commands, and external APIs are not treated as rollback by default.
Receipts distinguish restored, cleanup-attempted, not-reversible, and
indeterminate outcomes where applicable.

## Compatibility And Supersession

- Existing `browser_agent_task` one-action steps remain a compatibility adapter
  during migration. They do not define the primary delegated-execution cadence.
- The per-surface skill `execute` tool may compile/submit a whole program, but
  gateway QuickJS must not proxy each browser/Android/macOS primitive call.
- Existing action proposal decoders and their dangerous-key denylist remain
  intact. Program envelopes use different types/decoders and never pass through
  action parameters.
- The browser userscript decision remains valid for page-local evaluation and
  persistent page changes. This change supplies the outer local orchestration
  runtime and closed proposal/event/receipt contract.
- Context-aware capability resolution still returns descriptors and proposals,
  never effects. A runtime advertisement becomes another target constraint, not
  a dynamic provider function schema or connector installer.

## Isolated QA And Release

Automated browser QA uses a disposable profile, local fixture origins, separate
extension storage, and synthetic accounts. It does not enumerate, screenshot,
serialize, package, or upload unrelated tabs. Android instrumentation uses a
fixture APK/emulator or explicitly dedicated test device and resets fixture app
data; it does not read other apps. macOS uses a dedicated test account/VM and
fixture app with TCC grants scoped to the candidate identity; it does not capture
the user's desktop. Server tests use isolated data stores, queues, ports, and
artifact roots.

Coverage is measured after behavior tests. Every new executable source module
must exceed 90% line and branch coverage on its own; generated bindings and
declarative schema fixtures may be reported separately but cannot dilute the
module gate. QA artifacts contain fixture identifiers and hashes, never captured
personal content.

Compilation, an unsigned app bundle, an extension zip, an APK, a script run, an
install, and active promotion are different evidence states. Each surface is
installed or promoted only through its existing release path after isolated QA
and the repository promotion gate. No automated test launches or modifies the
user's foreground apps/profile as part of deployment.
