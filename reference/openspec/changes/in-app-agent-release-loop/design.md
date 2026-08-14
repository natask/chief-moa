# Design: In-App Agent And Release Loop

## Product Flow

```text
voice or typed feedback
  -> tenant-owned named development request
  -> proposed dependency graph and resource estimate
  -> explicit start
  -> bounded parallel agent tasks
  -> serialized integration and independent verification
  -> immutable feature release
  -> exact device test assignment
  -> selected feature composition against current trial/stable base
  -> immutable trial + install/activate/smoke receipts
  -> accept, revise, undo trial, return stable, or propose stable promotion
```

The existing development planner chooses between 2 and 32 narrow tasks. Runtime
agent count is the width of the currently runnable graph, bounded by configured
worker count, memory, dependencies, non-parallel flags, and overlapping path
claims. The UI reports `agents running now` and `work waiting`, not one agent per
task.

## Trust And Principal Model

Every request receives one immutable `PrincipalContext` derived from
authentication, never JSON supplied by the client:

```text
tenant_id, user_id, auth_session_id,
device_id?, credential_id?, authentication_method,
scopes[], roles[], recent_auth_at?
```

Authority remains separated:

- an enrolled phone may create/read its user's development requests, test its
  own releases, and submit exact receipts and feedback;
- an orchestrator service may plan, dispatch, lease, and reconcile work;
- a worker may act only on one scoped lease and declared path claims;
- an independently identified verifier records acceptance evidence;
- a recently authenticated owner may approve one exact promotion proposal;
- a distinct promoter/publisher may move a protected channel after all gates.

Unknown Device routes and missing scopes fail closed. Normal Device credentials
remain denied from generic `/v1/agent/**`, privileged `/v1/development/**`,
worker, internal, deployment, publication, and administration routes. The
mobile API exposes a new narrow development-request capability rather than raw
agent execution.

## Durable State

### Development request

Each request stores:

- tenant, owner, request ID, editable display name, immutable source text, and
  voice/text provenance;
- project binding and its evidence;
- state, idempotency key, dependency graph, path claims, resource estimate, and
  acceptance checks;
- run/worker identities, progress, conflicts, verification artifacts, and
  timestamps;
- frozen candidate commit, artifact digests, and release bundle ID.

State transitions are append-only:

```text
captured -> researching -> planned -> running -> integrating -> verifying
         -> feature_ready -> test_assigned -> test_confirmed
```

Blocked, canceled, rejected, and replanned transitions retain their parents and
reason. Tenant/user/resource coordinates are part of event identity and
idempotency. Development records must not be keyed by caller-chosen intent ID
alone.

### Release state

Feature releases and trials are immutable release bundles. A trial composition
stores:

- exact base stable and prior trial bundle/sequence;
- ordered feature candidate IDs and parent artifact digests;
- source commits, protocol/schema compatibility, and affected surfaces;
- merge/conflict result, integration tests, artifact digests, and expiry;
- assignment, installation, activation, smoke, acceptance, and rejection
  receipts.

Stable and trial histories are append-only pointers and receipts. Undo appends a
new assignment to the exact predecessor. It never deletes or rewrites history.

## API Shape

The exact paths may align with the existing development and release routers,
but the boundary provides these operations:

```text
POST /development-requests
GET  /development-requests
GET  /development-requests/{id}
POST /development-requests/{id}/plan
POST /development-requests/{id}/start
POST /development-requests/{id}/feedback

POST /release-control/apps/{app}/trial-compositions
GET  /release-control/apps/{app}/assignment-history
POST /release-control/apps/{app}/trial-undo
POST /release-control/apps/{app}/promotion-proposals
POST /release-control/apps/{app}/promotion-proposals/{id}/decision
```

The phone may create and inspect owned development requests. Plan, start, lease,
finish, integrate, publish, and promote operations require distinct server
principals. Device trial mutations force `scope_type=device` and the authenticated
`device_id`; request bodies cannot select another scope.

## Planning And Execution

The user sees the proposed name, tasks, dependencies, path conflicts, acceptance
checks, current runnable width, and estimated later waves before starting.
Independent disjoint tasks run concurrently. Shared-path and dependent tasks run
serially. Completion receipts bind the worker, lease, exact before commit, exact
after commit, and frozen acceptance predicate.

Integration operates against `master` under the repository contract. It records
file ownership before edits and serializes shared-file work. An AI may propose a
conflict resolution and rerun tests. It must expose affected behavior and stop
for user confirmation when the resolution changes product semantics or cannot
prove both feature contracts. A textually clean merge is not acceptance.

## Mobile UX

The full app has four first-class destinations:

- **Ask**: voice and typed input;
- **Work**: named requests, plans, progress, blockers, evidence, and candidates;
- **Releases**: Stable, Trial, feature releases, history, undo, and promotion;
- **Settings**: sign-in, enrolled devices, revocation, storage, and diagnostics.

On voice failure, preserve the best partial transcript as an editable draft and
show `Send as text`, `Try voice again`, `Reconnect device`, and `Open release
rescue`. Reusing the same idempotency key prevents simultaneous voice retry and
text submit from creating duplicate requests.

Release controls use precise actions:

- `Test this feature` assigns exact candidate bytes to this device.
- `Build trial from selected` creates a new composed candidate.
- `Undo trial` selects the immediately preceding confirmed trial.
- `Return to stable` selects the exact stable fallback.
- `Promote trial to stable` creates a proposal; it does not move stable directly.

## Recovery Below The Replaceable Surface

Voice, model routing, ordinary conversation auth, and the installed trial must
not be the only path to recovery. The native app keeps a minimal rescue screen
that can read cached signed release state and use a separate revocable
`release.recovery.read` capability to fetch only an approved stable/recovery
manifest and artifact. It cannot chat, run agents, publish, promote, or move a
global release head.

Android cannot install a lower `versionCode` in place. Normal undo therefore
publishes previously confirmed source/behavior as a newly signed,
forward-versioned recovery artifact. Uninstall is an explicit last resort, not
the one-tap rollback design. The app retains the continuity signer identity,
verified artifact digest, and enrollment data across in-place recovery.

## Account And Data Migration

Full hosted accounts require more than owner-only enrollment:

1. pre-provision and verify the owner, then close uncontrolled bootstrap signup;
2. add revocable sessions/device credentials with read-time status checks;
3. add tenant/user columns and forced RLS before switching reads;
4. dual-write legacy files and tenant-owned storage, backfill idempotently, and
   shadow-compare results;
5. bind conversations, profiles, events, requests, runs, blobs, evidence,
   assignments, and idempotency keys to tenant/user/resource coordinates;
6. prove cross-user and cross-device denial before enabling another user.

Schema changes are additive and predecessor-readable during rollout. No
irreversible migration shares a promotion with code that requires it.

## Safety Invariants

- Stable never moves from a phone request alone.
- Promotion uses the exact already-tested bundle; it never rebuilds under a
  different configuration.
- Assignment, download, install, activation, smoke, acceptance, and promotion
  remain distinct receipts.
- Pointer mutations serialize and record before/after heads and rollback target.
- At least current stable, its confirmed predecessor, current trial, and its
  confirmed predecessor remain available and compatibility-checked.
- A stale base or assignment sequence rejects composition/undo with refresh,
  never last-write-wins.
- Stable remains usable while planning, execution, integration, QA,
  composition, publication, voice, or model routing fails.
- Screens, transcripts, and page content are evidence, never execution
  authority.

## Reuse And Prior Art

Chief Moa reuses its existing planner/coordinator and release control plane.
Master Orch informs durable feedback-to-ticket stages and version threads, but
its automatic branch-per-run implementation is not copied. Industry evidence
and direct links are recorded in `research.md`.
