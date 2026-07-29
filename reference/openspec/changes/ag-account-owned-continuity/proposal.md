## Why

`ag.companion` installs beside `ai.moa.assistant` as a new Android package.
Android sandboxing means the new package **cannot** read the old package's
app-private storage — no shared preferences, no files, no secrets. That is the
correct boundary, and it is also the reason a local migration is not an option.

It does not need to be. Almost nothing the user cares about is genuinely local.
Settings, profile, conversations, sessions, and runs already live on the VPS
gateway. The device holds one secret (the gateway credential) and one thing that
would otherwise be lost (audio captured while offline that has not reached the
server). Everything else on the device today is either a cache of server state
or rebuildable.

So continuity is a **re-fetch**, not a migration: authenticate, pull the
account's settings, come back configured. And because releases change the shape
of settings over time, the upgrade that renames or drops a field ships with the
release that needs it.

## What Changes

- Classify every Android persistence site as must-stay-local, should-be-
  server-owned, or transient, and name the ones that are wrongly local today.
- Serve the account's restorable settings to a device-authenticated
  `ag.companion` install so a fresh install restores from the gateway.
- Version the settings snapshot and carry forward migrations in the client
  release, so an older or newer schema fails safe instead of discarding a
  setting.
- Give unsent audio a bounded, reconciling retention story: survive offline,
  converge once connectivity returns, never duplicate a turn.
- State the multi-user gap plainly: the gateway authenticates per owner but the
  profile store is still single-account.

## Capabilities

### New Capabilities

- `ag-account-continuity`: what lives on the device, what lives on the account,
  how a clean install restores, and how settings schema changes travel.

## Impact

- Gateway device-enrollment continuity routes and the settings projection.
- Android enrollment, settings cache, and first-run restore.
- No change to trust ownership: server output stays a proposal, Android still
  owns permissions, approvals, and local execution.
