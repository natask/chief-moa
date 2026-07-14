# Design: In-App Modification Requests

## Considered Shapes

### Same A.G. app (recommended)

Add a full-app request composer with an overlay shortcut. This preserves current
package, version, session, gateway, and project hints and minimizes restatement.

### Separate local master-org app

A central organizer could span many projects, but it duplicates authentication,
capture, approvals, project resolution, run status, and update lifecycle. A
generic shared screenshot also does not reliably identify its originating app.
Defer this surface while keeping the domain contract reusable.

### Hybrid

A.G. owns contextual capture/submission; a gateway-served or native control
center owns deep triage. A later organizer consumes the same contracts. This is
the selected long-term shape.

## Current Primitives And Gaps

- Android publishes a bounded accessibility snapshot containing current package,
  window class, freshness, and visible labels. It does not currently capture an
  Android bitmap screenshot.
- The gateway broker accepts project/subproject IDs and evidence refs and can
  produce non-blocking queued work.
- Current project inference is explicit ID or weak text overlap; there is no
  authoritative package/build/version → project/release binding.
- Worker-pull already keeps VPS and execution authority separate through scoped,
  allowlisted outbound claims.
- Work-history contracts describe snapshots, diffs, verification, and deployment
  evidence, but the full evidence chain is incomplete.

## Flow

```text
explicit user gesture in A.G.
  -> Android captures bounded current-app metadata
  -> optional self-view screenshot / user-shared screenshot
  -> local preview, crop, and redaction
  -> deterministic project/release resolution
  -> user confirms project and architecture-vs-implementation authority
  -> gateway persists proposed modification request + evidence refs
  -> optional explicit worker proposal and claim
  -> plan/diff/verification/deployment evidence returns to A.G. status UI
```

Opening or submitting the composer never launches work by itself.

## Evidence Contract

`modification_evidence.v1` contains:

- observation ID, capture time, and freshness;
- package/window identity and installed version name/code;
- signed or gateway-known release metadata where available;
- bounded accessibility summary labeled untrusted;
- optional screenshot artifact ref, hash, dimensions, MIME, retention, and
  redaction result;
- user description/transcript and session/branch/device IDs.

Bitmap bytes are a separately bounded artifact, never base64 inside broker events
or context packs. Screenshot and accessibility content cannot contain executable
instructions for the gateway or worker.

## Project Resolution

Use a versioned `surface_project_binding` and resolve in this order:

1. explicit active thread/project;
2. exact package/bundle/origin binding;
3. signed release/package metadata;
4. stored, inspectable user rule;
5. bounded inference returned only as a candidate.

Visible screen text cannot establish or mutate project identity. Low-confidence
resolution requires confirmation. Bindings are user-scoped, inspectable,
revocable, and may have device overrides.

## Modification Request

A request stores evidence refs, resolved project and basis, user objective,
authorization class (`architecture_only` or `implementation_authorized`), state,
and idempotency identity. Broad or ambiguous requests default to architecture.
Only an explicit current action may queue a worker proposal.

The worker independently reads repo instructions and current source, records a
before snapshot, and follows the existing verification, commit, preview,
promotion, and smoke gates. Android shows status and evidence but never executes
repository work.

## Capture Cases

- A.G. self-report: capture the app's own rendered view plus exact package and
  release metadata. This is the first slice.
- Another active app: use fresh accessibility package/class/text and an optional
  explicitly granted screenshot capability; fail visibly to text-only.
- Universal fallback: accept Android Shares into the same composer. Mark origin
  `unknown/shared` unless corroborated by a fresh observation.

## Open Decisions

- Screenshot retention duration and explicit keep/delete behavior.
- Whether a narrowly phrased request can select implementation authorization in
  the composer; recommendation: yes, explicit selector, architecture default.
- Whether the first implementation covers only A.G. self-report; recommendation:
  yes.
