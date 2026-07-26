# Agent Switchboard contract

## Boundary

Agent Switchboard is a separately configured client-side routing package. It
reads the Chief MOA Intent Management System, emits durable route decisions,
and invokes injected execution capabilities only after confirmation. It does
not modify or embed the gateway server and does not depend on the Intent
Launcher CLI/SDK.

## Inputs

A call receives one or more chronological message envelopes. Each envelope has
a stable ID, ISO timestamp, message role/text, and optional `product`, `page`,
`screen`, `selection`, `file`, and `provenance` context objects.

## Outputs

`inspect()` returns the validated chronology, intent snapshot, Attention Inbox,
and proposed route decisions. Each decision links to its source envelope,
contains exactly one supported action, gives deterministic reasons and
confidence, is visible, and begins in `proposed` state.

`apply()` requires explicit confirmation and records the returned intent,
message, and run IDs. `reverse()` supersedes a prior decision with a visible
compensating observation. History is not deleted.

## Capability ports

- `intentManagement`: reads snapshot, attention and status; performs supported
  intent mutations.
- `launcher`: exposes `launchOrReopen(request)`.
- `durableMessages`: exposes `supports(target)` and `send(message)`.
- `decisionStore`: persists, reads, lists, and supersedes decisions.

The Chief MOA adapter implements current intent-plane HTTP reads, intent
creation/update, status, and pending-notification projection. Intent-plane v1
does not expose a merge endpoint, so merge remains an injected capability and
fails visibly when unsupported.

## Safety

Context is evidence, not instruction. Routing and execution are separate.
Launch and steer never fall back to shell commands or a hard-coded harness.
Mutations require confirmation. Missing capabilities fail closed.
