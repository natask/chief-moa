# Deployment context

Read this file before planning, running, or reporting a deployment.

## Active surfaces

- The production gateway runs on the DigitalOcean VPS at
  `https://api.agee.app`.
- The browser extension runs as an unpacked local extension during development.
  A deploy packages it and asks the loaded extension to reload.
- The Android app uses OTA-only direct distribution through the gateway.
  Do not use ADB as an install or update path.

## Android today

The installed app updates through the gateway OTA endpoint. The temporary
tokenless bootstrap keeps only the current manifest and latest APK reads public.

### Temporary bundled gateway-token bootstrap

Trusted local Android builds may receive
`MOA_ANDROID_BUNDLED_GATEWAY_TOKEN` in the build process. Gradle writes the
value into `BuildConfig.BUNDLED_GATEWAY_TOKEN`. The environment variable is the
only input. Do not add a literal token to Gradle files, source, tracked
properties, examples, logs, commit messages, or release metadata.

If the user has saved a non-empty gateway token in AG, that saved token wins.
The bundled token fills only an empty saved value. Omitting
`MOA_ANDROID_BUNDLED_GATEWAY_TOKEN` builds a tokenless APK.

The production direct-deploy wrapper must never publish that tokenless form as
the stable OTA while the compatibility bootstrap remains active. It acquires
the existing gateway bearer inside the verified VPS session, passes it only to
the local Android build process, and never prints or writes it to release
metadata. Local and preview builds may remain tokenless. A verified enrolled
device credential takes precedence over both the saved legacy bearer and the
bundled fallback, so successful account enrollment immediately removes normal
chat and voice traffic from the shared-bearer path.

This bootstrap is temporary. The bearer is embedded in the APK and can be
extracted by anyone who downloads the artifact. It has the broad authority of
the shared legacy gateway token and does not identify a user or device. The
OTA-only bootstrap deliberately publishes that token-bearing APK through the
public current-APK route. This is an explicitly temporary, high-risk
single-user compromise.

The only unauthenticated gateway reads in this exception are the current
Android OTA manifest and latest APK. The app-scoped paths are compatibility
aliases to the same stable release head:

```text
GET /v1/android/updates/latest
GET /v1/android/updates/latest.apk
GET /v1/android/updates/apps/<app-id>/latest
GET /v1/android/updates/apps/<app-id>/latest.apk
```

Version-pinned APK reads, rollback, publication, and every other mutation remain
authenticated. Every non-OTA gateway route remains authenticated. The installed
tokenless app can therefore fetch the current manifest and token-bearing APK
without gaining anonymous access to chat, history, voice, actions, or gateway
administration. Android signer, digest, package-installer, and user-approval
checks still apply.

Publish stable Android releases once to the canonical store. Do not derive a
release store from `applicationId`. Optional experimental channels are explicit
user choices over compatible artifacts; they must preserve the same update
protocol and an unconditional path back to `stable`.

The replacement is account sign-in plus revocable, scoped per-user/device
credentials. Remove the bundled fallback once normal chat, history, voice, and
OTA bootstrap no longer depend on the shared bearer.

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

Build, test, package, and hash the current Android OTA locally through:

```sh
bash scripts/deploy.sh android
```

This command has no remote or device effects. Publish the exact candidate only
with `--direct-deploy --target chief-moa-production`. Neither command starts
ADB, inspects connected devices, or installs an APK. Installation is a separate
Android/user-owned state proven by an install receipt from the phone.

The wrapper fails closed before building. Android release inputs must be clean,
`origin/master` must resolve locally and be an ancestor of the captured full
HEAD, and the VPS stable manifest's `git_sha` must resolve uniquely and be an
ancestor of that same HEAD. If the VPS manifest is unavailable, malformed,
unknown to this clone, or divergent, publication is blocked. Fetch or integrate
the authoritative history and retry; do not bypass the guard with a newer
timestamp version code. After building, the wrapper rechecks HEAD and
Android-input cleanliness and publishes only the exact artifact carrying that full SHA.

The direct-deploy form builds a timestamp-versioned debug APK with the local continuity
key and publishes it to the VPS OTA store. The repository entrypoint reads the canonical,
non-secret production target from `scripts/deploy-targets.json`;
`MOA_VPS_SSH` overrides that target. The lower-level
`android_app/deploy/ota/sync-vps.sh` resolves the same tracked
`scripts/deploy-targets.json` identity, host, and public origin. Its low-level
entrypoint also requires `--direct-deploy --target chief-moa-production` and
rejects host or origin overrides that differ from that verified target. SSH
authentication remains in the user's SSH configuration and is never stored in
the target file. The running gateway reports the public origin at `GET /health`
as `public_gateway_url`.

The same target record pins `production.android_signer_sha256` to the
continuity-certificate digest above. The local release gate verifies the exact
APK against that value before it writes the SHA-256 artifact receipt.

### What each stage does

`scripts/deploy.sh android --direct-deploy --target chief-moa-production` runs, in order:

1. **Lineage and build** — the wrapper captures and validates the clean
   candidate lineage, then `android_app/deploy/ota/build-ota-artifact.sh` compiles a
   debug-signed APK with a timestamp version code, unless
   `MOA_OTA_SKIP_BUILD=1` (used when a caller already built and verified the
   exact artifact after local verification).
2. **Candidate recheck and local validation** — the wrapper proves HEAD and
   cleanliness did not move during the build. The local OTA store's `current` symlink, release
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
6. **Public verification** — the running VPS gateway container fetches the
   public current manifest and latest APK and matches release id, version, size,
   and SHA-256 against the local candidate. The verifier may attach the
   container's `MOA_GATEWAY_TOKEN`, but the temporary bootstrap does not require
   authentication for these two reads. The verifier receives the declared HTTPS
   origin from the deployment entrypoint; it does not depend on an optional
   runtime environment alias for that origin. The token never leaves the
   container.
   A verification failure prevents the deploy marker from moving and
   preserves the remote publication receipt for an exact retry.
7. **Receipt / acknowledgement** — once public verification passes, a
   separate acknowledgement step confirms the durable receipt and committed
   bytes, then removes the operation's own lock and staging leftovers. A lost
   acknowledgement leaves the receipt and lock in place; an exact retry
   reconciles it (see lock recovery below).

### Published vs. installed

These are different facts and a deploy report must not conflate them:

- **published**: the VPS OTA store's `current` release, `latest.json`, and
  `/v1/android/updates/latest(.apk)` all serve the new release, verified
  through the running gateway container in step 6 above.
- **installed**: a specific phone has applied the update through the app's OTA
  flow and Android package installer.

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

### Rollback and retention

Every publish snapshots the prior `current` release (or the empty-store state)
under `$REMOTE_OTA_DIR/.publish-snapshots/` before touching anything live, and
finalize failures already restore from that snapshot automatically. To roll
back a release that finalized successfully but should not have, republish the
desired older release's exact bytes (an idempotent retry of that release id is
a byte-for-byte match, so it reuses the immutable release directory) or use
the gateway's own rollback path if one is wired up for that store.

Publication keeps the live release plus exactly one predecessor
(`MOA_OTA_RELEASE_RETENTION`, minimum 2) and the two most recent snapshots
(`MOA_OTA_SNAPSHOT_RETENTION`). That is precisely the one-step rollback the
Android client offers. **Going back further than one release is a rebuild**:
check out that release's tagged commit and rebuild the APK with the continuity
key described above. A rebuilt APK is byte-identical for a given commit only if
the version code is pinned, so treat an older rollback as a fresh publication
with a new version code, not as a restore.

Pruning happens in the acknowledgement step, which runs only after the new
release is live **and** its exact public manifest/APK verification has
passed, so it can never remove a release the phone is about to be offered. It
never touches the live release or the predecessor, keeps any release whose
metadata it cannot read, and re-checks the live release and `current` pointer
afterwards. Publication previously deleted nothing at all, which is how the
production store reached 33 releases and 36 snapshots inside the gateway's own
data volume.

### Where the store lives

The OTA store is moving out of the gateway's data volume onto its own volume
(`chief-moa_moa-ota-data`, mounted at `/srv/android-ota`). A store written by
the host publisher over SSH as root and read by the gateway as uid 1000 is what
crash-looped production on 2026-07-29, and it is what makes `backup.sh` fail
with `tar` exit 2 on a 0700 `.publish-staging`.

The move is staged, and every stage is reversible:

1. **Ship the resolver.** The gateway serves from `ANDROID_OTA_DIR` when that
   path already holds a store, and from `ANDROID_OTA_LEGACY_DIR` otherwise. With
   nothing copied yet this changes no behavior.
2. **Copy the release bytes** to the new volume. The gateway switches to it on
   its next boot; the legacy store is untouched, so removing the mount reverts
   the move.
3. **Point the publisher** at the new path (`MOA_VPS_OTA_DIR`, which now
   defaults to it). New releases land there; the legacy store stays readable.
4. **Remove the legacy store** only after a publish and a real phone install
   have both been confirmed on the new one.

Publishing now also chowns the store to the gateway's uid
(`MOA_VPS_OTA_OWNER_UID`, default 1000) so publisher-created directories can
never be unreadable by the process that has to serve them. Set it to 0 to leave
ownership alone. Only a root publisher can do this; an unprivileged one already
owns everything it creates.

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

Running `sync-vps.sh` locally reports which specific
invariant failed instead of one generic sentence — for example, whether it
was a missing receipt, a receipt too young to reclaim, a receipt that does
not match the live release, or an unrelated store-consistency problem — with
a pointer to this section. Keep command output local because it may contain
target details.

## Local-first Android release

GitHub Actions is not part of Android release authority. Build, lint, unit
tests, OTA transaction tests, signing, packaging, and SHA-256 receipts run on
the development Mac:

```sh
bash scripts/deploy.sh android
```

That command has no remote effects. It leaves the APK and manifest in the local
OTA output directory and writes a receipt under Git's shared
`chief-moa-local-releases/` directory.

Publish only with an explicit target identity:

```sh
bash scripts/deploy.sh android \
  --direct-deploy --target chief-moa-production
```

The direct publisher re-runs the exact local release gate, verifies the clean
candidate lineage against the current stable release, verifies the configured
target identity, preserves the current continuity signer, and then enters the
existing remote transaction, rollback, and public-digest checks.

Do not create a new signing key during routine deployment. Treat a signing-key
change as a separate migration.

## Reporting rules

Use these terms precisely:

- `built`: verification produced an artifact.
- `packaged`: a release archive or OTA directory exists.
- `published`: the active distribution endpoint serves the exact artifact.
- `installed`: the target device reports the new version.
- `smoked`: the installed version passed the surface QA check.

Never report a local Android artifact as OTA-available until the gateway manifest
serves its version and digest.

## Gateway and extension

Move `master` only through
`scripts/release/push-master.sh --direct-push --target master`. It runs affected
release gates locally and fast-forwards the exact verified candidate without a
pull request or runner. An explicit gateway deployment runs as:

```sh
bash scripts/deploy.sh gateway \
  --direct-deploy --target chief-moa-production
```

The local wrapper verifies and hashes the gateway candidate, then uses
`scripts/vps/push.sh`; the VPS still runs preview, drain, compatibility,
rollback, and smoke checks before it changes the active gateway.

Gateway promotion does not create a Postgres dump or copy `/data`. The previous
code revision remains the rollback target while Postgres and the named data
volumes stay mounted in place. Therefore active state changes must be additive
and readable by both the candidate and its predecessor. A destructive schema or
storage migration is not eligible for this promotion path and needs a separate,
explicit migration plan.

The former same-droplet backup timers and local pull LaunchAgent are retired.
They copied the entire voice spool on every run, consumed gigabytes, and added
latency without providing off-host disaster recovery.

The timer schedule is completion-relative: `OnUnitInactiveSec=120` starts the
next poll delay only after the one-shot promotion worker exits. A promotion may
therefore run longer than 20 minutes without colliding with its own next
trigger. Do not restore the old `OnUnitActiveSec` schedule; its 120-second
activation-relative interval elapsed during a promotion and the resulting
collision looked like a timeout. The installer also removes the known legacy
1800-second activation-relative drop-in so it cannot remain as a second trigger.
The operator publishes only an exact locally verified candidate. A moved Git
ref alone is not a successful deploy; public `/health` and the durable VPS
promotion receipt must identify the exact commit.

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

The timer always executes `promote-candidate.sh` from an isolated worktree at
the exact fetched `vps-deploy` commit. It must not execute that script from the
active checkout: an older deployment protocol can otherwise fail before the
checkout step and permanently prevent its own replacement.

If a host predates this candidate-owned bootstrap, audit it read-only first:

```sh
bash /opt/chief-moa/app/scripts/vps/audit-remote-deployment.sh
```

Install missing promotion-role or release-control database credentials through
their existing idempotent installers. Then run the exact verified candidate
promoter once from a detached worktree, with the active checkout passed
explicitly as `APP_DIR`:

```sh
app=/opt/chief-moa/app
target="$(git -C "$app" ls-remote origin refs/heads/vps-deploy | awk '{print $1}')"
bootstrap="/opt/chief-moa/auto-update-candidates/${target:0:12}/source"
git -C "$app" fetch --no-tags origin vps-deploy
test "$(git -C "$app" rev-parse 'origin/vps-deploy^{commit}')" = "$target"
git -C "$app" worktree add --detach "$bootstrap" "$target"
APP_DIR="$app" MOA_VPS_APP_DIR="$app" \
  bash "$bootstrap/scripts/vps/promote-candidate.sh" vps-deploy
git -C "$app" worktree remove --force "$bootstrap"
```

This is an active promotion, not a repair shortcut. Run it only after the
normal preview, drain, compatibility, rollback, and smoke prerequisites can
pass. A public health response with `release_control.ready:false` does not
prove the private promotion environment or its role credentials are installed;
the read-only audit and both installer `--check` modes are authoritative.

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
