# Device-Reachable Preview Policy

## User Contract

Every deployable candidate must become an isolated, persistent preview that the
user can reach from the device that owns the affected surface. A successful CI
build, uploaded artifact, temporary runner process, or loopback-only smoke
environment is not a preview deployment.

The preview remains available after its build and QA workers stop. It stays
bound to one immutable release bundle and its exact artifact digests until the
user accepts it, rejects it, or an explicit expiry policy closes it. The control
plane must show which surfaces are available, which are blocked, and which are
intentionally absent from a compatible partial bundle.

User acceptance promotes the exact previewed bundle according to release
policy. User rejection first restores affected assignments to their recorded
last-known-good stable bundle, then deprovisions candidate-only runtime
resources. Rejection does not erase immutable artifacts, evidence, feedback, or
release receipts needed for audit and diagnosis.

## Isolation And Reachability

A deployable preview must have:

- a stable preview identity and device-reachable URL, feed, package, or
  assignment;
- state stores, queues, storage paths, worker pools, credentials, and callback
  targets isolated from active production;
- an explicit expiry and cleanup owner;
- a known stable fallback for every affected assignment;
- an exact bundle id, release id, surface id, artifact SHA-256, source revision,
  and preview endpoint or package locator;
- post-publication smoke evidence from the closest real surface available.

Simulated or local QA may contribute evidence before publication, but lack of a
simulator does not turn a CI artifact into a deployment. When policy permits
user-led QA, the release plane publishes the isolated candidate, records the
remaining real-device check as pending, and lets the user test those exact
bytes.

## Surface Acceptance Checks

### Gateway

- The preview uses a non-production URL and separate database, object storage,
  queue, and worker identity.
- The URL remains reachable after the deployment job exits.
- `/health` and one bounded authenticated request identify the expected source
  revision and release bundle without reading or mutating production state.
- Receipts record `published`, `assigned`, and `smoked` for the exact gateway
  artifact before it may be accepted.

### Browser extension

- Verification and smoke checks pass for the exact packaged archive.
- The preview exposes that immutable archive and version to the assigned test
  browser.
- A loaded browser confirms the expected extension version and artifact digest
  after a user-approved development reload or store-managed installation.
- Packaging alone is not installation; receipts record `packaged`,
  `published`, `installed`, `activated`, and `smoked` separately.

### Android

- The preview APK uses the current continuity signer and has a unique,
  monotonic version code.
- The assigned phone can fetch the exact preview manifest and APK without
  changing the stable OTA head for other devices.
- The app verifies size, SHA-256, and signer before the user approves the
  Android package installer.
- Receipts record `published`, `offered`, `installed`, `activated`, and
  `smoked` separately. A GitHub Actions APK signed with a temporary debug key is
  only `built`.

### macOS

- The preview publishes the exact application bundle or archive through a
  device-reachable preview locator.
- Production-like installation requires stable application identity, Developer
  ID signing, notarization, and stapling. An unsigned QA bundle must be labeled
  local QA and cannot satisfy the published/installable preview gate.
- The target Mac confirms the expected version, artifact digest, signing
  identity, launch, required TCC permission behavior, and bounded surface smoke.
- Receipts record `packaged`, `signed`, `notarized`, `published`, `installed`,
  `activated`, and `smoked` separately.

## Decision And Cleanup Receipts

The release plane must retain an append-only sequence for each preview:

```text
candidate_created
  -> artifact_built
  -> artifact_verified
  -> preview_published
  -> preview_assigned
  -> platform_installed / activated / smoked
  -> user_accepted
       -> stable_promoted / rollout_smoked
     OR
     user_rejected
       -> stable_reassigned / fallback_installed / fallback_smoked
       -> preview_deprovisioned
```

Every receipt names the candidate, bundle, surface, artifact digest, actor,
timestamp, and prior receipt or assignment sequence. Promotion must name the
exact accepted preview head and previous stable head. Rejection must name the
restored last-known-good assignment. Deprovisioning must name the runtime,
storage, and credential resources removed while preserving the immutable audit
record.

The UI must never compress these states into “deployed everywhere.” It reports
each surface independently and emits an all-surfaces-ready state only when every
surface required by the bundle has matching publication and smoke receipts.
