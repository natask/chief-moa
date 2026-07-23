## Product Model

```text
source host + local/hosted development machines
  -> ephemeral, least-authority build/QA runners
  -> immutable artifacts + provenance + QA evidence
  -> persistent release control plane
       identity / tenants / role bindings / delegation grants
       applications / surfaces / release bundles
       preview + stable channel heads
       user/cohort/device assignments
       promotion proposals / approvals / receipts / rollback
  -> platform adapters and stores
  -> applications report offered / installed / activated / smoked state
```

The control plane is persistent. Runners and clients are replaceable. A runner
receives one job id, source ref, expected outputs, upload destinations, and an
expiry-bound token. It may append evidence for that job only. It cannot move a
channel or administer a user.

## Core Records

### Tenant and identity

- `tenant`: durable authority boundary. Personal V0 creates one tenant owned by
  one user.
- `principal`: human user, service runner, or device identity.
- `role_binding`: tenant role (`owner`, `administrator`, `release_manager`,
  `tester`, `viewer`) plus bounded resource scope.
- `delegation_grant`: owner/authorized-admin statement naming grantor, grantee,
  allowed actions, applications/channels/cohorts, expiry, and revocation state.

No principal may grant itself authority. Owner recovery is separate from normal
administrator delegation. Sensitive operations require recent authentication
and an append-only receipt.

### Application and release graph

- `application`: product identity such as Chief Moa.
- `surface`: independently packaged/runtime target such as Android, browser
  extension, web, gateway, macOS, or Windows, with platform trust requirements.
- `artifact`: immutable bytes, digest, provenance, compatibility, and native
  trust identity.
- `release_bundle`: immutable mapping of surfaces to artifacts plus compatible
  dynamic-layer/feature-profile versions. Missing surfaces are explicit; a
  partial bundle cannot masquerade as a full product release.
- `channel_head`: signed, monotonic pointer from a named channel to a bundle.
- `assignment`: tenant/user/cohort/device selection of a channel and optional
  compatible feature profile.
- `last_known_good`: last installed/activated and smoked stable bundle per
  assignment/surface.

### Workflow and evidence

- `candidate`: proposed bundle before channel movement.
- `evidence`: typed exact-artifact receipt (`built`, `verified`, surface QA,
  signed/notarized, published, installed/activated, smoked).
- `promotion_proposal`: candidate, source review/merge request if needed,
  target channel/cohort, required evidence policy, proposer, approvals, and
  expiry.
- `promotion_receipt`: exact before/after heads, policy version, actor,
  evidence set, rollout scope, and rollback target.
- `fallback_receipt`: assignment/channel movement back to last-known-good stable
  or forward-moving corrective release.

## Preview and Stable Frames

The UI may render two frames, but they are views over channels:

- Preview shows the candidate bundle, evidence progress, assigned test cohort,
  and blockers. It may update frequently.
- Stable shows the active bundle, rollout, health, last-known-good predecessor,
  and current user/device assignments.

Opening preview changes an assignment; it does not merge Git or mutate stable.
Returning to stable restores the stable assignment immediately for dynamic/web
surfaces. Native clients still follow their platform's installation/rollback
rules; the control plane must report `assigned_to_stable` separately from
`stable_installed`.

## Promotion From An Application

An application navigation surface may submit:

```text
propose promotion(candidate, target channel/cohort, reason)
```

The control plane authenticates the principal, evaluates its delegated scope,
freezes the candidate identity, and opens a promotion proposal. If source policy
requires a merge, a source-host adapter opens/merges the reviewed change only
after branch checks pass. Artifact promotion remains a second explicit phase so
source merge and active release are never conflated.

## Channels and Assignments

Channels are reusable release streams, not automatically one per user:

- shared: `stable`, `preview`, optional team/canary channels;
- personal: created only when a user needs a distinct binary/config stream;
- assignment: selects a channel for a tenant, cohort, user, or device;
- precedence: device > user > cohort > tenant default, with every override
  visible and reversible;
- fallback: an assignment records its stable parent and last-known-good bundle.

A user may select an administrator/channel provider through an explicit grant.
Following that administrator means accepting channel assignments within the
grant's scope, not transferring account ownership or unrelated authority.

## Feature Profiles and AI Composition

An AI request such as “give me X and Z but not Y” produces a proposal containing
feature ids and constraints. A deterministic resolver checks:

- dependencies and conflicts;
- required surface/artifact/protocol versions;
- tenant policy and entitlement;
- whether changes are declarative or require executable code;
- whether the selected bundle has exact QA for the resulting composition.

Compatible declarative changes produce a new immutable feature-profile version.
Executable or incompatible changes produce a new build candidate and restart
the affected surfaces' QA lanes. The model never directly assembles or activates
unverified privileged code.

## Persistence and Hosting

V0 should use an append-only relational event/receipt model with materialized
current views:

- Postgres for tenants, principals, grants, applications, bundles, channel
  heads, assignments, proposals, and receipts;
- immutable object storage for artifacts, attestations, and bounded QA logs;
- a queue for build/QA jobs leased to local or hosted runners;
- signed channel heads and short-lived scoped runner/device tokens;
- audit projection rebuildable from canonical events.

The control plane may initially run alongside Master Orch operationally, but it
has its own API, database, identity boundary, and backups. Chief Moa clients and
other applications integrate through the protocol rather than importing
Master-Orch internals.

## Implemented V0.2 Slice

The current repository slice implements these parts:

- The domain normalizes immutable multi-surface bundles, channel-head events,
  assignment events, install receipts, and exact-release feedback.
- The service resolves assignment precedence, records preview or stable device
  assignments, records last-known-good stable fallback, and rejects stale
  assignment sequences.
- The memory adapter supports deterministic tests. The Postgres adapter reads
  tenant/application-scoped bundles and heads, then appends assignments, install
  receipts, and feedback.
- The additive migration creates append-only bundle, channel-head, assignment,
  install-receipt, and feedback tables. Triggers reject update, delete, and
  truncate operations.
- The framework-neutral HTTP handler requires an injected authentication
  function. It takes tenant and actor identity from that trusted result rather
  than request JSON.
- The HTTP view exposes stable and preview candidates for one application and
  device. Assignment and fallback responses set `install_confirmed` to false and
  return a platform action.
- The Android full app and browser side panel contain strict release-view
  parsers and actions for preview/stable assignment, last-known-good fallback,
  and exact-release feedback.

The service tracks platform state as separate receipts:

```text
assignment recorded
  -> installed
  -> activated
  -> smoked
```

A later receipt cannot prove an earlier state for different bytes. Each receipt
must match the assignment event, bundle, surface, release, and artifact digest.
The view reports each state separately.

The Android client keeps package installation behind an explicit user review.
It may download and verify an offered APK, then open the system installer. The
browser client cannot replace extension code through this protocol. It reports
that the selected extension binary still needs a platform-approved reload or
store update.

## V0.2 HTTP Boundary

The implemented transport uses these routes:

```text
GET  /v1/release-control/apps/{application_id}/view
POST /v1/release-control/apps/{application_id}/assignments
POST /v1/release-control/apps/{application_id}/fallback
POST /v1/release-control/apps/{application_id}/install-receipts
POST /v1/release-control/apps/{application_id}/feedback
```

Assignment writes use `expected_assignment_sequence`. A stale value returns a
conflict and does not change the assignment. Channel assignment retries use an
idempotency key. Install and feedback records use immutable receipt ids.
Feedback must match the active assignment and exact artifact bytes.

The handler is a library boundary. It does not open a port, create a Postgres
pool, apply migrations, issue credentials, or seed bundle/channel records.

## Deployment Blockers

The V0.2 code cannot become an active product surface until a deployable host
does this work:

- Mount the HTTP handler behind the production identity boundary.
- Create a separate control-plane database, apply the migration, and prove
  backup and restore.
- Publish immutable bundle records and monotonic stable/preview head events.
- Bind published download URLs to the exact artifact digests in each bundle.
- Align the HTTP release view with both strict client projections and pass one
  shared service-to-client contract test.
- Align Android lifecycle receipt names with the service's accepted states.
- Add health, smoke, rollback, and state-compatibility checks for the hosted
  service.
- Deploy the Android and browser client changes after their surface checks pass.

Signed channel heads, promotion proposals, approval receipts, runner tokens,
exact-artifact QA ingestion, feature profiles, and delegated administration
persistence remain later slices.

## Delivery Order

1. Personal V0 identity, tenant owner, applications/surfaces, immutable bundles.
2. Preview/stable heads, assignments, last-known-good fallback, read UI/API.
3. Exact-artifact evidence ingestion and runner job tokens.
4. Promotion proposals with owner/release-manager approval and receipts.
5. Android/browser/web adapters, then signed macOS/Windows adapters.
6. Scoped administrator delegation and team/cohort assignment.
7. Feature-profile resolver and AI proposal surface.
8. Multi-tenant hardening, invitation/recovery policy, quotas, and billing only
   if the hosted product requires them.
