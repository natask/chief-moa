# Tasks

Each implementation ticket has one observable acceptance check. Shared-file
work runs in sequence. Independent lanes may run concurrently only after path
claims are recorded in `agent-index.md`.

## 0. Safety Prerequisites

- [x] 0.1 Preserve exact historical fallback artifact binding after stable
      advances (`ce10359f`).
- [x] 0.2 Deny enrolled Device credentials from agent, development, internal,
      deployment, and other high-authority route families (`67d2447b`).
- [x] 0.3 Remove GitHub Actions from the release-authority path and retain local
      guarded verification/promotion (`a9d330c0`).
- [ ] 0.4 Add own-device enforcement to release assignment/fallback service
      operations and negative tests for forged scope/user/device identifiers.
- [ ] 0.5 Add revocable device credential state and HTTP/WebSocket parity tests.

## 1. Demonstrable Recovery Slice

- [ ] 1.1 Preserve a failed voice turn's best transcript as an editable draft
      with one idempotency identity shared by voice retry and text submit.
- [ ] 1.2 Show distinct actions for `Send as text`, `Try voice again`,
      `Reconnect device`, and `Open release rescue`.
- [ ] 1.3 Add a native rescue view backed by cached signed release metadata and
      a narrow `release.recovery.read` capability independent of conversation
      and model availability.
- [ ] 1.4 Produce forward-versioned, continuity-signed recovery artifacts for
      confirmed predecessors; keep uninstall as an explicit last resort.

Acceptance: invalidate conversation auth and voice transport, preserve and send
the draft after re-pairing, then use release rescue to install an exact signed
stable recovery without granting chat, agent, publisher, or promoter authority.

## 2. Hosted Identity And Per-User Data

- [ ] 2.1 Pre-provision and verify the owner account, close uncontrolled signup,
      and require recent authentication for sensitive approvals.
- [ ] 2.2 Add revocable user sessions and device credentials with stable tenant,
      user, device, application, surface, and scope binding.
- [ ] 2.3 Add tenant/user ownership and forced RLS to conversations, profiles,
      events, requests, runs, evidence, blobs, and release assignments.
- [ ] 2.4 Dual-write, backfill, and shadow-compare legacy storage before switching
      reads; retain a predecessor-readable rollback path.
- [ ] 2.5 Add two-account isolation tests for guessed session, request, artifact,
      profile, blob, event, and assignment identifiers.

Acceptance: two accounts enroll separate devices; every cross-account or
cross-device read/write returns 404/403, and revocation ends HTTP and WebSocket
access without affecting the other user.

## 3. Named Development Requests And Planning

- [ ] 3.1 Add tenant-owned idempotent development requests with editable display
      names, immutable source text, project binding, and voice/text provenance.
- [ ] 3.2 Add list/detail projections and mobile-safe progress updates.
- [ ] 3.3 Reuse the existing planner to propose 2–32 dependency/path-claim tasks,
      acceptance checks, memory estimate, and runnable width without launching.
- [ ] 3.4 Require explicit start after plan review; use a server orchestrator
      principal rather than giving the phone raw agent authority.
- [ ] 3.5 Bind task completion to worker lease, before/after commit, frozen
      acceptance predicate, and independent verifier identity.

Acceptance: one typed request creates one named card, displays a six-task plan
with three runnable agents and later serialized work, and launches only after
the user starts it. A simultaneous retry creates no duplicate.

## 4. Android Work Surface

- [ ] 4.1 Add `Ask`, `Work`, `Releases`, and `Settings` destinations without
      enlarging the compact overlay.
- [ ] 4.2 Render request name, state, active/waiting agent counts, dependency
      summary, path serialization, acceptance checks, blockers, progress, and
      candidate evidence.
- [ ] 4.3 Let a user submit a second request while the first runs and steer,
      cancel, or follow up on either durable request.
- [ ] 4.4 Connect exact-release feedback to a named revision request without
      automatically authorizing implementation.

Acceptance: two named requests remain independently navigable; failure of one
does not block testing the other's successful feature release.

## 5. Feature Releases And Trial History

- [ ] 5.1 Add backward-compatible display name and one-line summary metadata to
      immutable release bundles and Android candidate cards.
- [ ] 5.2 Make `Test this feature` an exact own-device candidate assignment that
      does not move stable or trial heads and does not claim installation.
- [ ] 5.3 Add paginated append-only assignment/trial history with exact bundle,
      artifact, predecessor, actor, and receipt state.
- [ ] 5.4 Add `Undo trial` to the immediately prior confirmed trial and keep
      `Return to stable` as a separate exact operation.
- [ ] 5.5 Reject stale assignment/base sequences and refresh the UI.

Acceptance: test Feature A on one device while another remains stable, then undo
to the exact previous confirmed trial with a forward-versioned artifact and no
local data loss.

## 6. Trial Composition And Conflict Repair

- [ ] 6.1 Accept an ordered set of exact feature candidate IDs plus current
      stable/trial base sequence and create a durable composition request.
- [ ] 6.2 Validate parent existence, dependencies, compatibility, path claims,
      and exact source/artifact provenance before integration.
- [ ] 6.3 Serialize overlapping paths; let an integration agent propose conflict
      repairs and rerun the frozen feature and integration checks.
- [ ] 6.4 Stop for user confirmation on semantic ambiguity; retain current trial
      when resolution or verification fails.
- [ ] 6.5 Publish one immutable composed bundle whose lineage names every exact
      parent and whose receipts bind the integrated commit and bytes.

Acceptance: compose Feature A and B, inject one shared-file conflict, show the
conflict and proposed resolution, then publish only after both feature contracts
and integration checks pass. Stable never moves.

## 7. Trial-To-Stable Promotion

- [ ] 7.1 Persist exact promotion proposals, expiry, owner decision, evidence
      policy, before/after heads, and rollback target.
- [ ] 7.2 Require recent owner authentication and separate proposer, verifier,
      and promoter identities.
- [ ] 7.3 Queue the existing least-authority publisher only for the exact
      installed, smoked, and confirmed trial bundle.
- [ ] 7.4 Fail closed on missing preview smoke, compatibility, drain/resume,
      rollback, backup/restore, or exact-artifact evidence.
- [ ] 7.5 Expose immutable stable history and forward-moving restore receipts.

Acceptance: promotion first fails with missing evidence, then moves stable to
the exact confirmed trial after all gates; the previous stable remains a tested
rollback target.

## 8. Verification And Release

- [ ] 8.1 Add contract fixtures consumed by release-control, gateway, and Android
      parsers, including N-1 compatibility.
- [ ] 8.2 Run cross-tenant, cross-device, missing-scope, revoked-token,
      forged-ID, stale-sequence, idempotency, and HTTP/WebSocket negative tests.
- [ ] 8.3 Run gateway, release-control, Android lint/build/unit, source-size, and
      OpenSpec gates for each affected slice.
- [ ] 8.4 Use a separate verifier for the full acceptance demo.
- [ ] 8.5 Commit each coherent unit on `master`, create exact artifacts/previews,
      then use guarded promotion only when rollback, compatibility, drain, and
      smoke evidence pass.

Acceptance: `acceptance-demo.md` passes from a signed-in Android device and all
receipts point to the exact commits and artifact digests exercised.
