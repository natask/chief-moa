# Deployment context

Read this file before planning, running, or reporting a deployment.

## Active surfaces

- The production gateway runs on the DigitalOcean VPS at
  `https://api.agee.app`.
- The browser extension runs as an unpacked local extension during development.
  A deploy packages it and asks the loaded extension to reload.
- The Android app uses direct distribution. The first install uses USB and ADB.
  Later updates come from the gateway OTA endpoint.

## Android today

The phone app was installed with:

```sh
cd android_app
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Android accepts an update only when its application id and signer match the
installed app. The current continuity signer is the debug certificate stored on
this development Mac in `$HOME/.android/debug.keystore`.

The current certificate SHA-256 is:

```text
8f0b62c73777a961687041f6faac24597830127d1f0ca9841aa6f7c70fe6ae0d
```

Historical USB and OTA APKs use this certificate. Keep using it until a planned
key migration proves how every installed device will move without losing app
state.

Build and publish the current Android OTA through:

```sh
bash scripts/deploy.sh android
```

This command builds a timestamp-versioned debug APK with the local continuity
key, publishes it to the VPS OTA store, and installs the same APK over ADB when
an authorized phone is connected. The repository entrypoint reads the canonical,
non-secret production target from `scripts/deploy-targets.json`;
`MOA_VPS_SSH` overrides that target. The lower-level
`android_app/deploy/ota/sync-vps.sh` accepts `MOA_VPS_SSH`/`--host` and
`MOA_VPS_PUBLIC_GATEWAY_URL`, but falls back to the same tracked
`scripts/deploy-targets.json` (`production.vps_ssh` and
`production.public_gateway_url`) when neither is set, so running it directly
(for example to recover a stuck lock, see below) does not require already
knowing the deploy target. Both remain overridable. SSH authentication
remains in the user's SSH configuration and is never stored in the target
file. If you need the public gateway origin and do not have the target file
handy, the running gateway also reports it at `GET /health` as
`public_gateway_url`.

### What each stage does

`scripts/deploy.sh android` runs, in order:

1. **Build** — `android_app/deploy/ota/build-ota-artifact.sh` compiles a
   debug-signed APK with a timestamp version code, unless
   `MOA_OTA_SKIP_BUILD=1` (used when a caller already built and verified the
   exact artifact, e.g. CI's stable-signed path).
2. **Local validation** — the local OTA store's `current` symlink, release
   directory, and legacy compatibility files must be byte-consistent before
   anything is sent over the network.
3. **Backup (remote preflight)** — over SSH, the VPS acquires a publish lock,
   snapshots the existing `current` release (or records that the store is
   empty) into `.publish-snapshots/`, and stages the new release privately
   under `.publish-staging/`. Nothing in the live store is touched yet, and no
   prior release, snapshot, or lock is ever deleted here.
4. **Upload** — `rsync` copies the new release and legacy artifacts into the
   private staging directory only. No command mirrors or deletes the remote
   `releases/` tree.
5. **Finalize** — the staged bytes are re-verified, the immutable release
   directory is installed (or reused byte-for-byte on an idempotent retry),
   legacy `moa-assistant.apk`/`latest.json` are refreshed, and `current` is
   replaced atomically last. A failure here restores the prior snapshot
   before returning; if the restore itself cannot be verified, the store
   stays locked for manual recovery rather than guessing.
6. **Public verification** — the running VPS gateway container uses its own
   `MOA_GATEWAY_TOKEN` to fetch the authenticated public manifest and APK and
   matches release id, version, size, and SHA-256 against the local
   candidate. The verifier receives the declared HTTPS origin from the
   deployment entrypoint; it does not depend on an optional runtime
   environment alias for that origin. The token never leaves the container.
   A verification failure prevents the deploy marker from moving and
   preserves the remote publication receipt for an exact retry.
7. **Receipt / acknowledgement** — once public verification passes, a
   separate acknowledgement step confirms the durable receipt and committed
   bytes, then removes the operation's own lock and staging leftovers. A lost
   acknowledgement leaves the receipt and lock in place; an exact retry
   reconciles it (see lock recovery below).

Optional ADB installation produces a separate receipt: no attached phone or an
install failure does not invalidate an already verified publication.

### Published vs. installed

These are different facts and a deploy report must not conflate them:

- **published**: the VPS OTA store's `current` release, `latest.json`, and
  `/v1/android/updates/latest(.apk)` all serve the new release, verified
  through the running gateway container in step 6 above.
- **installed**: a specific phone has actually applied the update, which
  `scripts/deploy.sh android` only attempts when an authorized device is
  already connected over ADB (`direct_install_android` in `scripts/deploy.sh`).

A publish can succeed with no phone connected; report that as "published, not
installed" rather than as a deploy failure. The phone itself checks for
updates independently from:

```text
GET /v1/android/updates/latest
GET /v1/android/updates/latest.apk
```

The app checks the manifest size and SHA-256. Android checks the package signer.
The app also compares the downloaded signer with the installed signer before it
opens the package installer. The user then approves the installer.

### Rollback

Every publish snapshots the prior `current` release (or the empty-store state)
under `$REMOTE_OTA_DIR/.publish-snapshots/` before touching anything live, and
finalize failures already restore from that snapshot automatically. To roll
back a release that finalized successfully but should not have, republish the
desired older release's exact bytes (an idempotent retry of that release id is
a byte-for-byte match, so it reuses the immutable release directory) or use
the gateway's own rollback path if one is wired up for that store. Snapshot
lifecycle (pruning old snapshots) is a separate, explicit maintenance step;
publication itself never deletes rollback evidence.

### Recovering a stuck publish lock

The remote OTA store uses `.publish-lock` to serialize publishes. A publish
that fully committed (wrote its receipt, moved `current`, refreshed the
legacy files) but whose process then died before its own cleanup leaves an
**abandoned** lock — every fact about the release it describes is still true
and live, only cleanup did not run. `sync-vps.sh`'s preflight step detects
this automatically: if the lock's receipt matches the live store exactly, it
moves the old lock into `$REMOTE_OTA_DIR/.publish-locks-recovered/` (kept as
evidence, never deleted) and proceeds with the new publish, even when the new
publish is a different release than the one the stuck lock describes. When
the new publish is an exact retry of the same release the stuck lock already
describes, this reconciles immediately. When it is a different release, a
receipt younger than `MOA_OTA_LOCK_RECLAIM_MIN_AGE_SECONDS` (default 300s) is
left alone instead, in case its owner is still finishing its own
acknowledgement step; retry after a few minutes.

A lock with **no receipt** means a publish is genuinely in flight or crashed
before finishing — this is exactly the state the lock exists to protect, and
it is never auto-reclaimed. If you are certain (by checking the VPS directly)
that no publish is actually running, remove `$REMOTE_OTA_DIR/.publish-lock` by
hand only after confirming `current`, the release directory, and the legacy
files are all consistent with each other; do not delete it blind.

Running `sync-vps.sh` locally (not through CI) reports which specific
invariant failed instead of one generic sentence — for example, whether it
was a missing receipt, a receipt too young to reclaim, a receipt that does
not match the live release, or an unrelated store-consistency problem — with
a pointer to this section. CI intentionally keeps this message generic: the
`Publish through the existing VPS sync path` step in
`.github/workflows/android-ota-vps.yml` deliberately withholds `sync-vps.sh`'s
full output because it may contain target details that should not sit in a
shared build log. That withholding is intentional and untouched; only the
locally-run message got more specific.

## Android GitHub Actions migration

GitHub Actions is the desired release path. It is still a migration target.

A GitHub runner creates its own debug keystore unless the workflow receives a
stable continuity key. An APK signed with that temporary key cannot update the
USB-installed app. A green credential-free Android build proves compilation and
packaging only. It does not prove that the artifact can update the phone.

Before GitHub Actions may publish Android OTA updates:

1. Store the current continuity key in the protected release environment.
2. Verify its certificate digest against the value in this file.
3. Build the exact OTA APK with that key.
4. Compare the APK signer with the installed phone signer or a captured installed
   base APK.
5. Publish through the existing VPS transaction and rollback checks.
6. Complete one real-phone update and smoke check.

Do not create a new signing key during routine deployment. Treat a signing-key
change as a separate migration.

## Reporting rules

Use these terms precisely:

- `built`: verification produced an artifact.
- `packaged`: a release archive or OTA directory exists.
- `published`: the active distribution endpoint serves the exact artifact.
- `installed`: the target device reports the new version.
- `smoked`: the installed version passed the surface QA check.

Never report an Android CI artifact as OTA-available until the gateway manifest
serves its version and digest.

This checkout may mark `.github` files as sparse or skip-worktree. If a workflow
is absent from the working tree, inspect it with:

```sh
git show HEAD:.github/workflows/<workflow>.yml
```

## Gateway and extension

Move `master` only through `scripts/release/push-master.sh`. Gateway CI moves the
verified commit to `vps-deploy`. The VPS timer then runs preview, backup, restore,
drain, compatibility, and smoke checks before it changes the active gateway.
The workflow now remains incomplete until public `/health` reports the exact
published commit. A green ref-publication job alone is not a successful deploy.

For the first release that adds the separate release-control database, install
its two distinct role passwords without restarting the active gateway:

```sh
bash scripts/vps/install-release-control-database-credentials.sh --install
```

The candidate promoter checks these credentials before taking a backup or
starting an isolated preview. The installer never prints their values and is
idempotent. A stale pre-release updater cannot bootstrap the new backup format
by republishing the ref alone; run the verified candidate promoter from its
isolated fetched worktree once. Later timer promotions are self-contained.

When the live VPS cannot safely host a candidate, start a device-reachable,
isolated Mac preview:

```sh
bash scripts/preview/gateway-lan.sh start
bash scripts/preview/gateway-lan.sh smoke
```

The command reports LAN/Tailscale URLs and the private token-file path without
printing the token. It uses separate temporary data and a per-start credential.
Stop and revoke it with:

```sh
bash scripts/preview/gateway-lan.sh stop
```

Build Android into a unique directory under `android_app/deploy/preview/`, then
serve that directory without changing the stable OTA head:

```sh
node android_app/deploy/ota/serve-preview.mjs \
  --dir android_app/deploy/preview/<candidate>
```

The server validates manifest/APK size and SHA-256 before listening. It prints
only the bearer-token file path. A generated capability URL or QR may be used
for phone installation on the private LAN; stopping the process revokes the
capability. Report the APK as installed or smoked only after the phone confirms
those states.

For the unpacked browser extension, run:

```sh
bash scripts/deploy.sh extension
```

Report reload success only when the loaded extension polls again after it sees
the version change.
