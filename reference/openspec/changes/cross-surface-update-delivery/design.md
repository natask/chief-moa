## Context

Application delivery has two layers that should not be conflated:

1. a common decision layer that answers which immutable release a client may
   install and why; and
2. a platform layer that verifies and installs that platform's package using
   Android, browser-store, macOS, or Windows authority.

The common layer should be reusable. The final installation step cannot be
fully common because package formats, store rules, signatures, privileges, and
rollback behavior differ by platform.

## Goals

- One auditable release identity and channel protocol across all application
  surfaces.
- No manual rebuild/reinstall in the ordinary supported update path.
- Reuse maintained native or established updater mechanisms behind small
  adapters instead of building four update engines.
- Android and browser reach validated usefulness first without blocking macOS
  and Windows contract work.
- Every release/readiness statement is backed by typed evidence.

## Non-Goals

- No cross-platform silent-install promise.
- No remotely delivered executable code outside platform package mechanisms.
- No replacement for browser-store, Apple, Microsoft, Android package-manager,
  or enterprise update policy.
- No distribution certificate, store account, notarization credential, or
  production rollout created by this specification alone.
- No choice of a macOS/Windows third-party updater without a separate dependency
  and security review.

## Decision: One Envelope, Platform Adapters

The release service owns immutable release manifests and mutable, signed channel
heads. A client adapter fetches a channel head, verifies it, fetches its release
manifest, verifies it, evaluates compatibility and rollout eligibility, then
hands an immutable artifact to its platform installer.

```text
release build + verification
  -> immutable artifact(s)
  -> immutable signed release manifest
  -> signed channel head (stable/beta/development)
  -> client verifies common policy
  -> platform adapter verifies native package trust
  -> platform/store installs under local policy
  -> client posts a bounded install receipt after relaunch
```

The shared module never invokes a platform installer directly. It returns a
decision such as `up_to_date`, `eligible`, `deferred`, `incompatible`,
`revoked`, or `verification_failed`, plus the selected artifact and reason.

## Canonical Release Manifest

The manifest is canonical JSON with unknown semantic fields rejected for its
declared schema version. Signing and verification operate over the canonical
document with the `signatures` field omitted. At minimum it contains:

```json
{
  "schema_version": 1,
  "release_id": "rel_<opaque>",
  "product": "chief-moa",
  "surface": "android|browser|macos|windows",
  "version": "1.2.3",
  "build_number": 123,
  "git_sha": "<full commit sha>",
  "protocol": { "min": 1, "max": 2 },
  "published_at": "<RFC3339 UTC>",
  "supersedes_release_id": "rel_<opaque>",
  "artifacts": [],
  "release_notes": { "url": "https://...", "sha256": "..." },
  "signatures": []
}
```

Each artifact identifies `artifact_id`, OS/surface, architecture, package type,
immutable URL, byte size, SHA-256, install mode, and native trust expectations.
Native expectations include Android signing-certificate digest, browser store
and extension id, macOS bundle/team identity plus notarization requirement, or
Windows package identity and publisher digest as applicable. A URL is never an
identity; clients bind bytes to the manifest digest and size.

The release-control signature records an algorithm, key id, and signature. V1
uses an allowlisted asymmetric public key bundled or securely rotated into the
client; a checksum alone is not release authorization. Key rotation uses a
signed trust document with activation and overlap windows. Unknown keys,
expired trust documents, invalid canonicalization, or an invalid signature fail
closed while preserving the installed version.

## Signed Channel Head

A channel head is a small signed record containing channel name, surface,
monotonic sequence, target release id and manifest digest, publication time,
optional minimum client build, rollout policy, pause state, and expiry/freshness
limit. Stable, beta, and development are separate heads and never mutable fields
inside an artifact.

Rollout policy uses a stable, privacy-preserving client bucket derived locally
from a random installation id and release salt. The server need not receive the
raw installation id. A client outside the current percentage reports
`deferred`, not `up_to_date`.

Clients remember the highest accepted channel sequence. A lower sequence is
rejected unless accompanied by a separately signed, bounded rollback
authorization that names the affected channel, from/to releases, expiry, and
reason. This prevents an old but valid manifest replay from becoming an update.

## Compatibility

Before download, the common evaluator checks:

- surface, platform, and architecture match;
- build number is newer than the installed build unless an authorized recovery
  operation applies;
- the client and gateway protocol ranges overlap;
- any minimum OS/browser/updater version is satisfied;
- the release and artifact are not revoked;
- the channel is not paused and the client is inside the rollout cohort.

Compatibility rejection never uninstalls the working client and produces a
bounded reason safe to show in diagnostics.

## Rollback And Recovery

Rollback is planned before channel promotion. Each promoted release records a
known-good predecessor, immutable predecessor artifact availability, state
compatibility, and the platform-specific recovery strategy.

The preferred rollback is a forward-moving corrective release: rebuild the
known-good source with a higher build number and advance the channel sequence.
This works with platforms that reject version downgrades. A native downgrade is
allowed only if the platform supports it, persisted state remains compatible,
and a short-lived signed rollback authorization plus required local approval is
present.

A client that fails before install keeps its current version. A client that
installs but fails its relaunch health check records failure evidence and follows
the adapter's proven recovery strategy. The shared service may pause the channel
or supersede it; it cannot claim that a device rolled back until a post-relaunch
receipt confirms the installed release.

State migrations remain governed by the active-promotion safety gate. A client
package cannot use update delivery to hide an irreversible migration.

## Evidence And Claim Model

Release records use explicit, non-interchangeable evidence states:

- `built`: build completed and artifact digest/size were recorded;
- `verified`: required static/unit checks passed;
- `platform_signed`: native signature was inspected against expected identity;
- `notarized`: Apple notarization acceptance and stapling were verified, macOS
  only;
- `packaged`: a distribution artifact exists;
- `published`: the named store/feed/channel accepted the exact artifact;
- `offered`: an eligible real client observed the release;
- `installed`: the OS/store reports the expected installed identity/version;
- `smoked`: the relaunched application passed the named surface smoke;
- `production_ready`: all required prior evidence and rollback evidence exist
  for the named channel and cohort.

Every evidence item carries release id, artifact digest, environment/channel,
timestamp, verifier kind, and an artifact/log reference. CI success alone is not
`published`; an upload is not `installed`; a reload signal is not a confirmed
reload; notarization submission is not `notarized`; an unsigned simulator build
is not macOS readiness.

## Adapter Contract

Every adapter implements the same logical operations:

```text
currentInstallation()
check(channel) -> common decision
download(decision) -> verified local artifact
requestInstall(artifact) -> platform-owned result/pending state
confirmAfterRelaunch(expectedRelease) -> install receipt
recover(failedRelease, authorizedPlan) -> recovery result
```

Adapters expose capabilities rather than pretending they are uniform:
`background_download`, `silent_install`, `user_approval_required`,
`native_rollback`, `store_managed`, and `enterprise_managed`. Policy consumes
these facts; it does not infer them from the OS name.

### Android adapter

- Extend the existing gateway APK path rather than create a second updater.
- Use `/v1/android/updates` as the single stable endpoint and release head.
  App-scoped routes from the package-rename migration are compatibility aliases
  to that same head, never independent stores. Optional `beta` or `development`
  heads are explicit user-selected channels using the same protocol, package id,
  and signer rules; returning to `stable` is always available.
- Verify common signatures, manifest digest/size, APK package id/version, and
  signing-certificate continuity before package-installer handoff.
- Android/package installer retains final authority. Background checking or
  downloading does not imply silent installation.
- Recovery normally uses a higher-version corrective APK because ordinary
  Android installs reject downgrades.

### Browser adapter

- User distribution is store-managed. The common release record links the exact
  extension id, store version, package digest, and store publication evidence;
  the browser/store performs the update.
- The unpacked-extension bridge is development-only. It may package and signal a
  reload only when explicitly enabled and safe for current browser work.
- The adapter confirms the loaded manifest version after reload. A fired signal
  without version confirmation is `unverified`, never installed or smoked.
- MV3 code remains package-contained. Engine-served configuration continues
  through the separate thin-client data path.

### macOS adapter

- Wrap a maintained updater or platform distribution mechanism after dependency
  review; do not implement download/install machinery from scratch.
- Require a Developer ID-signed app/package, expected bundle/team identity,
  accepted notarization, and stapled ticket where the chosen distribution path
  requires it.
- Update feeds translate into the common manifest/channel decision and retain
  the updater's native signature protections. Real signed-hardware install,
  relaunch, and recovery evidence is required before readiness.

### Windows adapter

- Prefer a signed MSIX/App Installer or another maintained updater mechanism
  after dependency review; do not implement a custom elevated installer.
- Require expected package identity/publisher and Authenticode/package signature
  verification before install.
- Respect Windows user, enterprise, and elevation policy. Real Windows install,
  relaunch, and recovery evidence is required before readiness.

## Publication And Promotion

Publication is two-phase:

1. upload immutable artifacts and manifest, then fetch and verify them from the
   distribution endpoint; and
2. atomically advance the signed channel head only after required evidence and
   rollback checks pass.

Channel promotion never mutates an old manifest. Pausing a rollout publishes a
new signed channel-head sequence. Stable promotion starts with a bounded cohort
and advances only with install and smoke receipts. Missing credentials, store
access, hardware, safe interruption evidence, or rollback proof stops at the
highest evidenced state and records the blocker.

## Open Decisions Before Implementation

- Release-control signing service and key-custody mechanism.
- Artifact/feed hosting and retention policy per hosted/self-hosted deployment.
- Concrete maintained updater selection for macOS and, if MSIX/App Installer is
  insufficient, Windows.
- Browser stores and browsers in the first supported matrix.
- Whether install receipts are gateway product events or a dedicated release
  projection over product events.
