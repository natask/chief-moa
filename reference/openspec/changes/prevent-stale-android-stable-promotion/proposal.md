## Why

The Android stable OTA channel accepted a build from a source branch that did
not contain the previously released product-name change. A timestamp-derived
version code made older source look newer to Android. Clean working-tree checks,
APK integrity checks, and signer continuity all passed because none of them
prove that a candidate descends from the current stable release.

Stable release history must be durable product state, not an inference made
from the checked-out worktree, a timestamp, or worktree-local marker files.

## What Changes

- Make the persistent release control plane the sole authority for the current
  Android stable head and its monotonic sequence.
- Require every normal stable candidate to name and contain both the recorded
  stable source revision and the current source-policy revision (`origin/master`
  under the present repository policy).
- Bind each publication to immutable APK bytes, application id, signer digest,
  source revision, parent stable release, verification evidence, and rollback.
- Move stable through an atomic compare-and-swap. A publisher with a stale
  expected head or sequence fails without changing the OTA endpoint.
- Define an explicit, separately authorized recovery-release path instead of an
  environment variable or branch-side bypass.
- Keep Android `versionCode` monotonic for platform installation while making it
  evidence, never release authority.

## Capabilities

### Modified Capabilities

- `persistent-release-control-plane`: adds Android stable ancestry, product
  identity, global sequence, compare-and-swap, and recovery-release invariants.

## Impact

- Android OTA publication and deployment scripts must query and update the
  authoritative stable head instead of trusting the current worktree.
- The release-control schema/API must persist the stable Android lineage and
  globally monotonic channel sequence.
- CI and local publishers must produce the same exact-candidate evidence.
- A rejected stale candidate may still be built or published to an isolated
  preview; it cannot replace stable.
