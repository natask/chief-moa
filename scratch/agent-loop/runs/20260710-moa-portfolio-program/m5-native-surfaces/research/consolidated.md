# M5 consolidated research

## Topology

The gateway already owns durable voice, broker, work-run and event stores.
`define-aggie-compatible-surface/design.md` explicitly requires a facade rather
than a parallel gateway. The new seam should therefore validate canonical wire
objects and adapt to existing routes; it must not introduce another authority.

## Trust and data

- Server/model action output is a proposal. Native/browser clients validate
  kind, expiry, current state and approval before local execution.
- Screen/page context is evidence, never instruction.
- Surface envelopes contain no provider credential field and reject unknown
  action kinds or executable payload fields (`script`, `javascript`, `shell`,
  `command`, raw CSS).
- Stable session/surface/device identifiers are data fields, not metric labels.

## Failure and recovery

- Client-generated message IDs provide replay dedupe within a session.
- Resume uses the last acknowledged event sequence. Servers replay a bounded
  window or require a snapshot when the cursor is too old.
- Events are monotonic per session. Duplicate sequence+ID is harmless;
  conflicting reuse fails closed.
- Action proposals carry expiry and state preconditions. Stale proposals cannot
  be receipted as executed.
- Backoff is full-jitter exponential, bounded to 250–30,000 ms; buffers are
  bounded by both item and byte counts.

## Quality and resource gates

Protocol decision functions target cyclomatic complexity <=10 and CRAP <=15.
Wire envelopes are <=64 KiB, text <=16 KiB, context <=32 KiB, event replay <=256
items/1 MiB, and pending outbound buffers <=128 items/512 KiB. Parsing and
validation are synchronous bounded work; networking/storage stay outside the
module and off native UI threads.

## Native feasibility and current-fact boundary

macOS/iOS/Windows implementations require separate toolchain, accessibility,
secure-storage, signing/update and real-device evidence. Those facts are
unstable and platform-specific. This protocol slice deliberately does not
select signing APIs, updater frameworks or permanent companion/seamless UX.
Official platform research belongs in the later serial native lanes when MX is
green and signing/device authority is known.

## Model/tool choice

The active Codex reasoning model is used for the cross-cutting protocol. No
external model comparison or paid evaluation ran. Deterministic Node tests,
property-style hostile fixtures and fresh-context auditors are the evidence;
model reputation is not.
