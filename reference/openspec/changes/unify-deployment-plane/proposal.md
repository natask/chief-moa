## Why

chief-moa ships three surfaces through three deployment mechanisms that were
never designed together. The gateway pulls a verified git ref onto the droplet
and gates it with a full evidence chain. The Android OTA store is pushed from
the developer's Mac over SSH. The browser extension is packaged locally and
poked into reloading. They store artifacts differently, retain them
differently, and require different evidence. Nothing knows all three.

The audit is in `reference/architecture/deployment-plane.md`, written against
the live droplet on 2026-07-29. Three findings force this change.

**The surfaces collide on the filesystem.** The Android OTA store lives inside
the gateway's data volume. The publisher writes to it over SSH as root and via
`rsync` as the developer's macOS uid; the gateway reads it as uid 1000. On
2026-07-29 the publisher created `/data/android-ota/channels` as root mode
0700, `gateway/server.js:352` called `fs.mkdirSync` on a child of it at module
top level, and the resulting EACCES crash-looped the production gateway.
`https://api.agee.app` returned 502 for about half an hour. The same collision
had already been failing the promotion gate for days: `backup.sh:61` tars
`/data` and dies with exit 2 on the publisher's 0700 `.publish-staging`, and no
backup means no promotion.

**Failed deployments are deleting the user's backups.** Every promotion attempt
writes a ~1.3 GB backup and prunes to a count of 14. The journal shows 66 prune
events in five days. Fourteen of the fifteen backups on disk are from the last
thirty hours of failed retries; the real history is gone. Retention counted in
backups rather than in time means a retry storm evicts the only copy of the
user's recordings.

**Nothing knows what is running.** `update.sh`'s rollback path rebuilds without
`MOA_BUILD_SHA`, so after the outage production reports
`build.git_sha: "unknown"`. The gateway is healthy and unidentifiable, and the
CI job that waits for the exact commit can never match again.

The user asked for three things: stop hoarding versions, keep only the current
and previous, and build one centralized structure that knows the state of
everything. They also proposed the confirmation model — a release is good if
they use it and do not complain. This change specifies all of it.

## What Changes

- **Define one deployment plane.** One record per surface per version in the
  release-control database: surface, version, state, evidence reference, use
  count, complaints. One endpoint answers what each surface is on, what is
  confirmed, what is rolling out, and what failed. One command rolls a surface
  back to its last confirmed version.

- **Define the confirmed-version lifecycle.**
  `building -> previewed -> rolling_out -> active -> confirmed`, with
  `suspect` and `rolled_back` as exits. A version becomes `confirmed` only on
  time **and** use **and** silence. Silence alone never confirms, so an unused
  release cannot become a rollback target. Rollback targets the newest
  `confirmed` version and refuses when there is none.

- **Accept spoken complaints as deployment input.** A turn the agent classifies
  as a complaint about its own behaviour marks the active version `suspect` and
  records the turn id. A complaint opens a rollback conversation; it does not
  roll back on its own.

- **Remove deployment-time full-state copies.** Deployment artifacts keep the
  running version and exactly one predecessor. Postgres and named data volumes
  remain mounted in place during code rollout; eligible state changes are
  additive and predecessor-readable.

- **Stop the surfaces sharing a filesystem.** Move the Android OTA store out of
  the gateway's data volume, or make the publisher write as the gateway's uid.

- **Keep deployment identity through rollback.** The rollback rebuild passes the
  same `MOA_BUILD_*` variables as the forward path.

- **Fix the two bugs now** (implemented in this change, not deferred):
  publisher-owned OTA directories no longer kill the gateway at boot
  (`gateway/lib/android-ota.js`), and a deployment claim releases on lease
  expiry **or** matching claimant identity so a crashed run's own retry is
  admitted (`gateway/lib/deployment-claims.js`).

- **Delete or correct the dead gateway deploy path.** `deploy_gateway()` at
  `scripts/deploy.sh:151-170` targets the decommissioned main machine.
  `DEPLOYMENT.md` and `AGENTS.md` list it as an active promotion command.

## Non-Goals

- **Weakening runtime safety.** The M4 request/review/preview/verification/
  claim/effect/receipt chain, drain gate, preserved volumes, code rollback, and
  post-apply smoke still gate apply. Destructive state migrations are excluded.
- **Automatic rollback on complaint.** One frustrated sentence is not a
  deployment decision.
- **Replacing the M4 control plane.** The plane reads it; it does not supersede
  it.
- **Changing the Android signing story.** The continuity key migration stays a
  separate migration, as `DEPLOYMENT.md` requires.

## Costs

Rolling back one step stays cheap: the predecessor image is on disk, under a
minute. Rolling back two or more steps means a rebuild — about 13 minutes for
the gateway image on this droplet. For a single-user product
that is the right trade against permanently parking gigabytes of images, and it
is stated here so the choice is deliberate.
