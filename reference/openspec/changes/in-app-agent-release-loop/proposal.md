# In-App Agent And Release Loop

## Why

Chief Moa already has voice and typed input, a dependency-aware development
planner, agent-run execution, immutable release candidates, device assignment,
and stable fallback. Those capabilities are disconnected. A user cannot yet
turn feedback into a named, inspectable plan, test independent feature
releases, compose selected features into a trial, undo that trial, or promote
the exact tested trial to stable from one reliable mobile workflow.

Voice is an input method, not the control plane. When voice, model routing, or
normal conversation authentication fails, the user still needs typed feedback,
account recovery, and a release rescue path.

## User Outcome

From Chief Moa, a signed-in user can:

1. speak or type one or more named change requests;
2. inspect the proposed dependency graph and current agent count before launch;
3. run independent work in parallel and dependent work in sequence;
4. test every successful feature as an immutable release without moving stable;
5. compose selected features with the current trial into a new trial;
6. see conflicts, proposed resolutions, and verification evidence;
7. undo to the previous confirmed trial or return to stable;
8. request promotion of the exact confirmed trial to stable; and
9. use native recovery controls even when voice or the trial experience fails.

## What Changes

- Add a narrow, tenant-owned development-request boundary for mobile feedback,
  plan review, progress, and revision requests.
- Add first-class Stable, Trial, and Feature Release mobile flows with immutable
  history, exact undo, composition, and promotion proposals.
- Add native recovery below conversation, voice, model, and trial dependencies.
- Complete per-user identity, revocation, storage ownership, and negative
  authorization guarantees before enabling additional hosted users.
- Connect the existing planner, workers, verifier, release plane, and guarded
  publisher through exact commits, artifacts, evidence, and receipts.

## Terminology

- **Stable**: protected active release with a confirmed predecessor and rollback
  evidence.
- **Trial**: the signed-in user's/device's current composed test assignment.
  The existing wire-level `preview` channel remains compatible during migration.
- **Feature release**: immutable, independently testable candidate produced by
  one named request. The existing wire-level `candidate` remains compatible.
- **Promotion**: an evidence-gated request and server-side pointer movement. A
  phone never receives publisher or promoter authority.

## Scope

- Connect Android voice/text feedback to durable tenant-owned development
  requests.
- Present a reviewable plan before execution and show dynamic concurrency.
- Project development state and immutable feature releases into Android.
- Add exact trial composition, history, undo, and trial-to-stable proposals.
- Add an auth-independent, narrowly scoped native release rescue path.
- Complete account, device revocation, tenant ownership, and storage isolation
  required before more than one hosted user is enabled.
- Reuse the existing development and release planes rather than importing
  Master Orch internals.

## Non-Goals

- The phone does not choose harnesses, working directories, branches, secrets,
  publisher inputs, or arbitrary assignment scopes.
- Models do not approve their own work, silently resolve semantic conflicts, or
  move stable.
- Git branches are not release channels. This repository continues direct,
  guarded work on `master` under the operator contract.
- A release assignment does not claim installation, activation, or smoke.

## Current Prerequisites Completed

- `ce10359f` preserves the exact historical bundle/artifact binding when a
  device falls back after stable advances.
- `67d2447b` restricts enrolled device credentials to explicit mobile route
  families and denies high-authority development/agent routes.
- `a9d330c0` removes GitHub Actions as release authority; local guarded gates
  remain canonical.

## Success

The acceptance demo in `acceptance-demo.md` passes with two simultaneous named
requests, a dynamically sized plan, independent feature testing, a composed
trial, visible conflict handling, exact undo, and evidence-gated stable
promotion. Stable remains usable throughout every failure case.
