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

### V1 canonical bytes and closed profile registry

Except for program source, V1 canonical bytes are the UTF-8 encoding of the
JSON Canonicalization Scheme (JCS, RFC 8785) representation. Inputs MUST first
pass their closed schema: unknown keys, `undefined`, non-finite numbers, unsafe
integers, invalid Unicode, and duplicate semantic set members fail before
canonicalization. Arrays retain protocol order unless a field below is defined
as a set. A SHA-256 value is the lowercase hexadecimal SHA-256 of those bytes.

`program.sha256` is the SHA-256 of the exact UTF-8 source bytes. Catalog,
bindings, inputs, state evidence, and proposal digests use their named complete
canonical objects. A receipt's `receipt_sha256` uses the complete closed receipt
with the `receipt_sha256` key omitted, not present with `null`. The accepted
event's `proposal_sha256` covers the complete proposed envelope. Implementations
MUST NOT hash a parsed/re-emitted program string, a platform map description, or
a receipt containing its own hash.

V1 has this exact profile registry; `bridge_version` is the integer `1` and
`entrypoint` is the literal `main` in every row:

| `surface_type` | `runtime_id` | `language` | binding `kind` |
| --- | --- | --- | --- |
| `browser_extension` | `browser.javascript.v1` | `javascript` | `browser_document` |
| `android` | `android.webview-js.v1` | `javascript` | `android_accessibility` |
| `macos` | `macos.javascriptcore-ax.v1` | `javascript` | `macos_accessibility` |
| `macos` | `macos.jxa.v1` | `jxa` | `macos_apple_events` |
| `macos` | `macos.applescript.v1` | `applescript` | `macos_apple_events` |
| `macos` | `macos.shell.v1` | `shell` | `macos_shell` |
| `gateway` | `gateway.quickjs.v1` | `javascript` | `gateway_server` |

The row is atomic. No other surface, language, bridge, entrypoint, or binding
combination is a V1 profile. An unimplemented profile is not advertised merely
because its discriminant is reserved here.

### Runtime advertisement

The device-client heartbeat may include a closed runtime advertisement:

The all-zero digest strings in the wire-shape examples are type placeholders,
not valid cross-record verification fixtures; conformance fixtures MUST contain
their recomputed values.

```json
{
  "version": 1,
  "type": "surface.runtime.advertised",
  "advertisement_id": "sra_uuid",
  "target": { "surface_type": "browser_extension", "device_id": "device_uuid" },
  "runtime": { "runtime_id": "browser.javascript.v1", "language": "javascript", "bridge_version": 1, "entrypoint": "main" },
  "catalog": { "version": 7, "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "capability_ids": [] },
  "limits": { "source_bytes": 65536, "wall_ms": 30000, "memory_bytes": null, "tool_calls": 100, "parallel_calls": 8, "result_bytes": 65536, "log_bytes": 32768 },
  "issued_at": "2026-07-16T20:00:00.000Z",
  "expires_at": "2026-07-16T20:05:00.000Z"
}
```

Capability signatures remain in the existing local manifest/catalog. Each
descriptor has an exact input/output schema, effect class, approval class,
idempotency behavior, concurrency policy, and optional real restore capability.
Descriptions and schemas are inert data; they cannot install implementations.
A capability snapshot is usable only while the advertisement and current local
implementation both remain present.

The advertised catalog digest is recomputed from this closed snapshot:

```json
{
  "version": 7,
  "capabilities": [{
    "capability_id": "browser.page.observe",
    "description": "Observe bounded state for the bound fixture page.",
    "input_schema": {},
    "output_schema": {},
    "effect_class": "read",
    "approval_class": "none",
    "idempotency": "read_only",
    "concurrency": "parallel_read",
    "restore_capability_id": null
  }]
}
```

`capabilities` is sorted ascending by `capability_id` and IDs are unique.
`description` is required, nonempty, at most 500 UTF-8 bytes, comes from the
packaged/reviewed manifest rather than observed content, and is inert catalog
documentation rather than executable source or authority.
Schema objects are JCS-canonicalized normally and schema array order is
preserved; V1 catalog equality is byte-level, not inferred semantic equivalence.
Fields explicitly described as sets elsewhere in this contract are sorted and
deduplicated before catalog construction. Exact enums are:

- `effect_class`: `read`, `navigation`, `local_mutation`,
  `external_side_effect`, `destructive`, `security_sensitive`, `financial`,
  `publishing`, or `sending`.
- `approval_class`: `none`, `implicit_user_command`, `explicit_preview`, or
  `explicit_confirm`.
- `idempotency`: `read_only`, `idempotent`, or `non_idempotent`.
- `concurrency`: `parallel_read`, `serialized_resource`, or
  `exclusive_runtime`.

`restore_capability_id` is required and is either `null` or another capability
ID in the same snapshot. The advertisement's `catalog.capability_ids` is the
same sorted ID projection and `catalog.sha256` is the digest of the full
snapshot, not a digest of the ID array or a client-asserted string. The proposal
may select a sorted unique subset in `allowed_capability_ids`, but keeps the
full snapshot digest and version.

Advertisement `issued_at` and `expires_at` are canonical RFC 3339 UTC strings.
V1 permits at most 30 seconds of future clock skew and at most five minutes
between issue and expiry. Expiry MUST be after issue. Selection, proposal
creation, client claim, and final client acceptance each recheck freshness; a
proposal expiry is at most five minutes and never later than the selected
advertisement expiry. No skew allowance extends an expiry.

`limits` has exactly seven required keys. `source_bytes`, `wall_ms`,
`tool_calls`, `parallel_calls`, `result_bytes`, and `log_bytes` are finite
non-negative or positive safe integers as appropriate and MUST be independently
enforced by the client. `memory_bytes` is either a finite positive safe integer
that the host actually measures and enforces for this realm, or `null` when the
surface cannot provide independent memory accounting. Null does not mean
unlimited memory and the surface MUST NOT claim a memory bound; the surrounding
OS/runtime remains a containment layer. No other limit may be null or omitted.
The proposal preserves `null` or selects a finite value no greater than the
advertisement; it never turns an unavailable limit into a claim.

A surface advertises a profile only when its program host is independently
terminable: a dedicated worker/process the owner can terminate, or an embedded
engine with a host-side instruction/time interrupt. A timer scheduled on the
same event loop as generated code is not a wall-time control because a
synchronous infinite loop can block it. On timeout or stop, the owner revokes
the bridge before terminating the realm, prevents new host calls, bounds all
logs/results, and receipts an in-flight external effect as `indeterminate`
unless its outcome is proven. Advertising a finite budget while merely
recording, truncating after the fact, or hoping the platform kills the realm is
invalid.

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
  "bindings": { "kind": "android_accessibility", "package_name": "com.example.fixture", "window_id": "window_uuid", "observation_id": "obs_uuid", "observation_generation": 1, "state_sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
  "limits": { "source_bytes": 65536, "wall_ms": 30000, "memory_bytes": null, "tool_calls": 100, "parallel_calls": 8, "result_bytes": 65536, "log_bytes": 32768 },
  "approval_policy": { "program": "preauthorized", "always_ask": [] },
  "idempotency_key": "idem_uuid",
  "issued_at": "2026-07-16T20:00:00.000Z",
  "expires_at": "2026-07-16T20:05:00.000Z"
}
```

`bindings` is a closed discriminated union. All listed keys are required and
non-null unless a conditional form below explicitly says the keys are absent:

| `kind` | Exact additional keys and V1 types |
| --- | --- |
| `browser_document` | `tab_id` positive safe integer; `window_id` positive safe integer; `frame_id` non-negative safe integer; `origin` canonical HTTP(S) origin with no credentials; `document_id` nonempty opaque string; `page_epoch` positive safe integer; `observation_id` nonempty opaque string; `observation_sha256` digest; `state_sha256` digest |
| `android_accessibility` | `package_name`, `window_id`, and `observation_id` nonempty strings; `observation_generation` positive safe integer; `state_sha256` digest |
| `macos_accessibility` | `bundle_id` nonempty string; `pid` positive safe integer; `process_generation`, `signing_identity`, `window_id`, `ax_snapshot_id`, and `local_grant_id` nonempty opaque strings; `state_sha256` digest |
| `macos_apple_events` | `target_bundle_id`, `signing_identity`, and `local_grant_id` nonempty strings; `suite_allowlist` and `command_allowlist` nonempty sorted unique arrays of nonempty strings; `state_sha256` digest |
| `macos_shell` | `policy_id`, `cwd_profile_id`, `filesystem_profile_id`, `network_profile_id`, and `local_grant_id` nonempty opaque strings; `argument_sha256`, `environment_sha256`, and `state_sha256` digests |
| `gateway_server` | `tenant_id` nonempty opaque string; `state_sha256` digest; exactly one of `project_id`, `connection_id`, or `resource_id` as a nonempty opaque string |

`browser_document` has two exact closed forms. When
`browser.page.evaluate` is absent from `allowed_capability_ids`, the base keys
above are the complete object and `allowed_frames`, `allowed_worlds`, and
`site_grant_id` MUST be absent. When that capability is present, all three keys
are additionally required: `allowed_frames` is a nonempty sorted unique array
of non-negative safe integer frame IDs containing `frame_id`; `allowed_worlds`
is a nonempty sorted unique subset of `MAIN` and `ISOLATED`; and
`site_grant_id` is a nonempty local opaque grant ID. Adding those fields never
adds a capability absent from the immutable catalog subset.

Android V1 has no `app_grant_id` key. macOS Accessibility uses
`local_grant_id` and `ax_snapshot_id`, not the implementation-local aliases
`grant_id` or `observation_id`. `gateway_server` alternatives are exclusive:
zero or multiple resource selectors fail. A future additional binding field or
alternative requires a negotiated protocol version rather than permissive V1
decoding.

`program.source` must match `program.sha256`; runtime language and entrypoint
must match the advertised profile. Catalog `allowed_capability_ids` is the exact
immutable subset offered to the program. The canonical proposal digest covers
the entire record. `execution_id` and `idempotency_key` are one-shot within the
bound target; a replacement proposal gets new values and approval even when the
source is identical.

`approval_policy` has exactly the keys `program` and `always_ask`. `program` is
one of `preauthorized`, `local_policy`, or `approval_required`.
`always_ask` is a sorted unique subset of the `effect_class` enum above. It is
not a capability list. `preauthorized` means the surrounding approved envelope
may authorize effects except those classes; `local_policy` delegates each
decision to current local policy; `approval_required` requires explicit local
approval before start. Every mode still applies capability-specific policy and
the classes in `always_ask`; none bypasses an OS permission or a prohibited
effect.

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
  "kind": "accepted",
  "occurred_at": "2026-07-16T20:00:00.000Z",
  "claimant": { "surface_type": "android", "device_id": "device_uuid", "client_instance_id": "client_uuid" },
  "payload": { "proposal_sha256": "0000000000000000000000000000000000000000000000000000000000000000" }
}
```

`payload` is a closed discriminated union selected by `kind`, not an arbitrary
bag. Every listed payload key is required and non-null; no other key is valid:

| `kind` | Exact `payload` |
| --- | --- |
| `accepted` | `{ "proposal_sha256": digest }` |
| `started` | `{}` |
| `tool_started` | `{ "capability_id": string, "tool_call_id": opaque ID, "attempt": positive safe integer }` |
| `tool_finished` | `{ "capability_id": string, "tool_call_id": opaque ID, "attempt": positive safe integer, "status": tool status, "receipt_id": opaque ID, "receipt_sha256": digest }` |
| `approval_required` | `{ "approval_id": opaque ID, "effect_class": effect enum, "capability_id": string, "tool_call_id": opaque ID, "attempt": positive safe integer, "expires_at": RFC3339 UTC }` |
| `approval_resolved` | `{ "approval_id": opaque ID, "status": "approved"|"denied"|"expired"|"cancelled" }` |
| `progress` | `{ "message": safe summary, "completed": non-negative safe integer, "total": non-negative safe integer }`, with `completed <= total` |
| `stopping` | `{ "reason": "user_stop"|"timeout"|"policy_revoked"|"surface_shutdown" }` |
| `terminal` | `{ "status": terminal status, "receipt_id": opaque ID, "receipt_sha256": digest }` |

`accepted.proposal_sha256` is the canonical proposal digest.
`tool_finished` is emitted only after the referenced tool receipt is durably
committed and its identity, attempt, capability, status, and digest match.
`terminal` is emitted only after the referenced terminal receipt is durably
committed and its status/digest match. `approval_resolved` references a prior
unresolved `approval_required`; an approved resolution does not excuse a fresh
state check. `message` is 1 to 240 UTF-8 bytes and is constructed from local
protocol reason templates, counts, and opaque IDs, never observed content or
tool output.

Every event timestamp is canonical RFC 3339 UTC, no more than 30 seconds in the
future at ingestion and no earlier than proposal issue time minus that skew.
Timestamps are nondecreasing by sequence. Approval expiry follows its required
event and does not exceed proposal expiry; a terminal event cannot precede its
terminal receipt's finish time.

Sequence is a positive safe integer and starts at `1`. For an accepted run,
`accepted` is first and `started` is the next event after any start approval;
`terminal` is final. A client-side rejection before acceptance may emit only a
`terminal` event at sequence `1`. Tool starts and finishes pair by
`tool_call_id` and positive attempt; attempts start at `1` per call and increase
without gaps. Parallel tools may interleave, but each finish follows its start.
No event follows terminal and the claimant is immutable for the execution.

An event is an idempotent duplicate only when `execution_id`, `sequence`,
`event_id`, and every canonical byte match. Reusing an event ID or sequence
with different bytes is a conflict. A gap, reorder, unmatched finish/approval,
claimant change, or post-terminal event is rejected without advancing stored
sequence and requires reconciliation; it is never silently reordered. Unknown
kinds, fields, nullable substitutions, and kind/payload mismatches fail closed.

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
  "started_at": "2026-07-16T20:00:01.000Z",
  "finished_at": "2026-07-16T20:00:02.000Z",
  "status": "succeeded",
  "result": { "summary": "bounded", "data_sha256": null, "resource_id": null },
  "post_state_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
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
  "started_at": "2026-07-16T20:00:00.000Z",
  "finished_at": "2026-07-16T20:00:03.000Z",
  "status": "completed",
  "tool_attempts": { "count": 1, "first_receipt_sha256": "0000000000000000000000000000000000000000000000000000000000000000", "last_receipt_sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
  "result": { "summary": "bounded", "data_sha256": null, "artifact_refs": [] },
  "final_state_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "error": { "code": null, "message": null },
  "previous_receipt_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "receipt_sha256": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

Receipts bind the claimant and the program, catalog, and bindings digests.
They contain digests and bounded summaries, not raw screenshots, page bodies,
Accessibility trees, form values, stdout/stderr dumps, environment, or
credentials. Bulk evidence uses separately authorized encrypted artifacts.
Receipt chains are correlation/integrity evidence, not remote attestation.

Every key shown in each receipt is required. The only nullable tool-receipt
keys are `approval_id`, `result.data_sha256`, `result.resource_id`,
`post_state_sha256`, and `previous_receipt_sha256` under these exact rules:

- `approval_id` is non-null only when this attempt consumed the matching local
  approval; implicit or program-level policy without a per-call approval uses
  `null`.
- `data_sha256` is non-null only when separately retained bounded result bytes
  exist. `resource_id` is non-null only for a stable external opaque resource
  identifier. Neither field contains the bytes or a URL.
- `post_state_sha256` is non-null when a trustworthy canonical post-state was
  observed. It is mandatory for a `succeeded` capability whose effect class is
  not `read`; otherwise it may be `null` rather than inventing state.
- The first durably committed tool receipt has
  `previous_receipt_sha256: null`. Each later tool receipt names the immediately
  preceding tool receipt's verified hash. Parallel calls join this single chain
  in durable receipt-commit order, not start or completion-clock order.

All other tool fields are non-null. `attempt` starts at `1` per
`tool_call_id`; the pair is unique within an execution. Tool status is exactly
`succeeded`, `failed`, `rejected`, `stale_state`, `timed_out`, `stopped`, or
`indeterminate`. Start precedes or equals finish. `pre_state_sha256` is the most
recent trustworthy non-null post-state in the verified chain, otherwise the
proposal binding state.
`input_sha256` covers the exact schema-valid JCS tool input. A duplicate tool
receipt is accepted only when both its receipt ID and execution/call/attempt
identity resolve to identical canonical bytes; identity reuse with different
bytes conflicts.

The only nullable terminal-receipt keys are `started_at`,
`result.data_sha256`, `final_state_sha256`, `error.code`, `error.message`, the
two `tool_attempts` hashes, and `previous_receipt_sha256`, with these rules:

- `started_at` is `null` only for `rejected` before runtime start; every other
  status requires it, and it cannot follow `finished_at`.
- Terminal status is exactly `rejected`, `completed`, `failed`, `timed_out`,
  `stopped`, `interrupted`, or `indeterminate`.
- `error.code` and `error.message` are both `null` exactly for `completed`; both
  are non-null for every other status. Codes are closed by status:
  `rejected` permits `proposal_rejected`, `policy_denied`, `stale_state`, or
  `unsupported_profile`; `failed` permits `runtime_failed`, `tool_failed`,
  `receipt_failed`, or `limit_exceeded`; `timed_out` requires `timeout`;
  `stopped` permits `user_stop`, `policy_revoked`, or `surface_shutdown`;
  `interrupted` permits `runtime_interrupted` or `surface_shutdown`; and
  `indeterminate` requires `indeterminate`. Messages use safe local templates,
  never caught raw output.
- `final_state_sha256` is non-null only when a trustworthy canonical final state
  exists. `result.data_sha256` follows the tool-result rule.
- `tool_attempts.count` equals the number of verified tool receipts. Zero means
  both first/last hashes and terminal `previous_receipt_sha256` are `null`.
  Positive count requires first/last hashes matching the chain endpoints and
  terminal `previous_receipt_sha256` equal to the last tool hash.

The terminal receipt therefore closes, but is not itself included in, the tool
attempt chain. There is no separate cross-execution terminal chain in V1.
`receipt_sha256` is always required and recomputed using the self-hash exclusion
rule. Terminal/tool events MUST link the exact receipt ID, status, and verified
hash. A receipt from a different claimant, execution/session/turn, runtime,
program, catalog, bindings, capability subset, or receipt chain is rejected.

`result.summary`, `error.message`, and progress messages are nonempty
protocol-safe summaries of 1 to 240 UTF-8 bytes built locally from allowlisted
templates, counts, reason codes, and opaque IDs. They MUST NOT be copied or
interpolated from page/DOM content, form values, Accessibility/AX values or trees,
screenshots/pixels, clipboard data, tool stdout/stderr, environment values,
cookies, authorization headers, browser storage/session state, Keychain data,
passwords, tokens, credentials, or arbitrary exception/tool output.

`artifact_refs` is a sorted unique array of at most 32 opaque IDs matching
`artifact_[A-Za-z0-9_-]{1,120}`. URLs, paths, query strings, fragments, data
URIs, inline encodings, and user-controlled names are invalid. An ID resolves
only through the separately authorized encrypted artifact service, whose own
grant and retention policy are outside this receipt. Sensitive sentinel tests
apply to every summary, message, error, result field, and artifact reference;
length limits alone do not establish omission.

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
