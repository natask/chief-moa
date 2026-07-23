## Why

Moa's current deployment paths are surface-specific scripts and CI workflows.
They can build or publish artifacts, but they do not provide the persistent
product the user described: one authenticated place to inspect previews, test an
exact coordinated release across applications, choose who follows it, promote
it, fall back to stable, and delegate administration.

The missing primitive is a release control plane above individual applications.
Development machines and hosted runners must be replaceable workers. The
control plane must remain persistent and authoritative across worker shutdowns,
client restarts, Git branches, and individual deployments.

## What Changes

- Define a persistent release control plane with users, tenants, role bindings,
  delegated administration, applications, surfaces, immutable release bundles,
  channels, assignments, promotion proposals, QA evidence, and receipts.
- Treat `preview` and `stable` as product environments backed by signed channel
  pointers, not as Git branches or mutable server directories.
- Let a user/device/cohort temporarily follow preview and return to its recorded
  last-known-good stable assignment without rebuilding the application.
- Let clients propose promotion from their navigation surfaces while keeping
  merge, signing, channel movement, and rollout authority in the control plane.
- Define coordinated release bundles so Android, browser, web/gateway, macOS,
  and Windows artifacts can advance independently or as one compatibility-bound
  product release.
- Separate feature profiles from binary artifacts. An AI may propose a feature
  selection, but dependency/conflict validation decides whether existing
  compatible artifacts can serve it or a new build and QA cycle is required.
- Start personal-first with one tenant owner and optional scoped administrators,
  while using tenant-scoped identifiers and grants so multi-user hosting does not
  require an authority-model rewrite.

## Capabilities

### New Capabilities

- `persistent-release-control-plane`: Durable release graph, environment/channel
  views, promotion proposals, evidence, and receipts.
- `release-channel-assignments`: Tenant/user/cohort/device subscriptions with
  preview opt-in, stable fallback, and last-known-good state.
- `delegated-release-administration`: Owner-issued, scoped, expiring, revocable
  administrator grants with separation of proposer, verifier, and promoter.
- `feature-profile-resolution`: Declarative feature selection over compatible
  artifacts with dependency/conflict validation and rebuild escalation.

### Modified Capabilities

- `cross-surface-release-envelope`: Becomes the immutable artifact and evidence
  protocol consumed by the persistent control plane.

## Boundaries

- Git is a source and review system, not the release-state database. `master`
  may remain a source policy, but clients follow signed channels and assignments.
- Runners build, test, and upload evidence with short-lived job credentials.
  They cannot promote channels, grant roles, or rewrite release history.
- Clients may request a preview switch or promotion, but cannot sign their own
  release, approve their own evidence, or silently install platform packages.
- The release plane stores artifact metadata, channel state, assignments,
  grants, proposals, and receipts. It does not become the Android installer,
  browser store, Apple notarization service, or Windows package manager.
- Feature profiles are declarative data interpreted by already-shipped code.
  Arbitrary executable feature mixing requires a new signed binary release.
- Provider credentials, user content, conversations, and local action authority
  remain outside the release plane.

## Current Truth

- `gateway/lib/release-registry.js` validates immutable release records and
  evaluates one channel, platform, architecture, and rollout cohort in memory or
  a file. It has no users, assignments, grants, promotion workflow, or durable
  hosted authority.
- `scripts/release/release-evidence.mjs` now gives every surface one fail-closed
  evidence vocabulary, but it is read-only and does not persist receipts.
- `release_control_plane/` now contains a persistence-neutral domain and service,
  an authenticated HTTP boundary, a memory adapter, a Postgres adapter, and an
  additive migration chain. The implemented write path appends device
  assignments, install-state, and exact-release feedback records. It uses
  sequence checks to reject stale assignment writes.
- The gateway candidate packages and mounts that runtime against a separate
  logical database. It includes schema-first initialization, health state, and
  release-database backup/restore handling. The feature remains disabled by
  default until the staged production gate is complete.
- Device registration uses the existing account Bearer only for bootstrap. The
  client generates and durably stores a 256-bit opaque credential first; the
  database stores only its hash. Release routes accept only the bound Device
  credential, and the device role cannot publish, promote, approve, or delegate.
- A least-authority repository publisher validates committed source, exact
  artifact bytes, surface evidence, and monotonic channel state before one
  atomic bundle/head/receipt append. Stable also requires exact committed
  promotion evidence.
- The Android full app and browser extension side panel now contain release
  selection clients. They define strict stable/preview parsing, device
  assignment, stable fallback, and feedback bound to an assignment, bundle,
  release, surface, and artifact digest. Both bootstrap and use device-bound
  release credentials; Android excludes its credential from backup and device
  transfer.
- Assignment remains separate from install, activation, and smoke state.
  Android requires a second user-approved installer step for an offered APK.
  The browser reports that a binary reload is required. Neither client treats an
  assignment receipt as proof that the selected bytes are active.
- Android, browser extension, gateway/web, macOS, and Windows have different
  levels of build, signing, packaging, distribution, install, and smoke proof.
- Master Orch is named as the repository deployment control plane, but its
  persistent product/API boundary and tenant authority model are not defined in
  this repository.

The new slice is not active in production. Source now contains the host,
migration, device-authentication, and publisher paths, but their Docker runtime
and Postgres behavior have not been exercised on a Docker host. Production
still needs separate role credentials, a schema-first disabled rollout, a
backup and scratch restore that includes the release database, exact stable and
preview publication receipts, route enablement, and endpoint smoke before the
Android and browser clients are deployed. One shared fixture-to-both-client-
parsers contract test also remains open. Signed heads, promotion proposal and
approval persistence, runner evidence ingestion, and delegated administration
remain later work.

## First Milestone

Build a personal-first persistent V0 that can register one application with
multiple surfaces, create immutable preview/stable release bundles, assign the
owner's devices to preview or stable, record exact-artifact evidence, propose
promotion, and fall back to last-known-good stable. The schema and authorization
checks are tenant-scoped from day one; organization invitations, billing, and a
public marketplace remain later work.
