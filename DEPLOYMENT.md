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
MOA_VPS_SSH=user@vps bash scripts/deploy.sh android
```

This command builds a timestamp-versioned debug APK with the local continuity
key, publishes it to the VPS OTA store, and installs the same APK over ADB when
an authorized phone is connected. The host must come from `MOA_VPS_SSH` or the
`--host` option on `android_app/deploy/ota/sync-vps.sh`. The script does not
guess it. The phone downloads later updates from:

```text
GET /v1/android/updates/latest
GET /v1/android/updates/latest.apk
```

The app checks the manifest size and SHA-256. Android checks the package signer.
The app also compares the downloaded signer with the installed signer before it
opens the package installer. The user then approves the installer.

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
