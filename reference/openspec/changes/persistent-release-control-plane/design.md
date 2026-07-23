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
