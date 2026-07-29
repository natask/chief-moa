# Design

Detail behind `proposal.md`. The full audit and its evidence live in
`reference/architecture/deployment-plane.md`.

## Decision 1: one table, in the release-control database

The plane needs a store that survives a gateway rollout and already holds
deployment evidence. That is the release-control Postgres database the
promotion path bootstraps
(`scripts/vps/install-release-control-database-credentials.sh`).

    surface_version
      surface        gateway | android | extension
      version        commit sha, or Android release id
      state          building|previewed|rolling_out|active|confirmed|suspect|rolled_back
      since          timestamp of entry into that state
      evidence_ref   M4 request id, or OTA publication receipt id
      use_count      qualifying interactions recorded while active
      complaints     jsonb array of {turn_id, at, summary}

One row per surface per version. State transitions are appended as events the
same way the M4 chain is, so the current row is a projection and the history is
never overwritten.

Rejected: a JSON file on the droplet. It would sit in the same data volume that
caused the outage, and it would not survive the volume being restored from a
backup taken at a different version.

## Decision 2: confirmation needs use, not just silence

The user's rule is "if I'm not complaining, it's good". Implemented literally,
that confirms a release nobody exercised, which is exactly how a broken version
becomes the rollback target.

A version becomes `confirmed` only when all three hold:

| Gate | Rule |
|---|---|
| Time | at least 24 hours in `active` |
| Use | the surface's exercise threshold met **while this version was active** |
| Silence | no complaint recorded in that window |

Exercise thresholds, initial values, tunable:

- **gateway** — 20 successful voice turns from a real device. Health checks,
  CI probes and the preview stack do not count; qualifying turns must carry a
  device or session identity.
- **android** — the app reports the new version and completes at least one
  voice turn. Publication is not use; `DEPLOYMENT.md:113-123` already separates
  published from installed and this makes that distinction load-bearing.
- **extension** — at least one overlay interaction after the reload is
  confirmed.

`active` is a normal resting state. A version that is never used simply stays
`active` and never becomes a rollback target. Nothing is broken by that.

Rollback resolves to the newest `confirmed` version for the surface. When there
is none, rollback **refuses and says so**. It does not fall back to "previous",
because previous-without-confirmation is the thing this decision exists to
avoid.

## Decision 3: complaints are spoken, and scoped

The user talks to the agent all day. That is the cheapest available signal and
it needs no new UI.

A complaint is a turn the agent classifies as dissatisfaction **with its own
behaviour** — not with the weather, a third-party service, or the content of an
answer. Scoping matters: an unscoped classifier would mark every frustrated
sentence as a deployment signal.

Every complaint that moves a version to `suspect` records the turn id, so a
misclassification is visible and can be reversed. `suspect` blocks confirmation
and opens a rollback conversation. It never triggers a rollback by itself.

Explicit phrases ("roll back", "go back to yesterday's version") skip
classification and go straight to the rollback conversation.

Automatic signals — crash loops, error-rate spikes — also mark `suspect`. The
2026-07-29 outage is the worked example: a crash-looping container should have
marked its version `suspect` within a minute, not waited for the user.

## Decision 4: artifacts are disposable, backups are not

Two policies, because they protect different things.

**Artifacts** — keep the running version and one predecessor.

| Artifact | Keep | Rebuild |
|---|---|---|
| Gateway image | running + 1 | ~13 min on the droplet |
| Preview worktree | current candidate | seconds |
| Evidence JSON | current + 1 | not rebuildable; Postgres is the record, the file is a cache |
| Android release dir | `current` + 1 | Mac rebuild, needs the continuity key |
| Publish snapshot | 1 | it is the predecessor |

**Backups** — keep by age, never by count.

- everything for 7 days
- one per day for 30 days
- one per month, off-host, indefinitely
- promotion backups tagged `reason=promotion` and pruned aggressively;
  `reason=scheduled` backups are never evicted by promotion churn

The current policy is a count of 14 with every promotion attempt writing 1.3 GB
(`backup.sh:106-137`). Sixty-six prunes in five days collapsed a fourteen-day
window into about five hours. Age-based retention with tagged reasons is the
minimum fix; the tag is what stops a retry storm from evicting history.

Never prune on-host until the off-host mirror
(`scripts/vps/pull-backups.sh`) is verified for that backup.

## Decision 5: separate the OTA store from the gateway volume

Preferred: give the OTA store its own volume and mount it read-only into the
gateway. The publisher owns it; the gateway serves from it and never creates
anything in it.

This fixes three things at once. The gateway can no longer die on a
publisher-owned directory. `backup.sh` no longer tars publish snapshots into
every gateway backup, which is most of the 1.3 GB. And the two surfaces stop
having a shared failure domain.

Fallback, if the volume split is deferred: the publisher chowns everything it
creates to the gateway's uid. Weaker — it depends on every future publisher
code path remembering — but it removes the outage class.

Either way the boot-time fix stays. `ensurePublisherOwnedDir` treats
EACCES/EPERM as a degraded channel and everything else as fatal, so a gateway
never dies over a directory another surface owns, and a genuinely broken data
volume still fails loudly.

## Decision 6: the plane records, it does not relax

Every existing check stays. Backup and restore-check run before the active
service is touched. The M4 chain gates apply. The drain check runs immediately
before mutation. Public verification gates the OTA receipt.

The plane adds one thing on top: after apply succeeds, it records the version
as `rolling_out`, then `active` once health holds, and later `confirmed` once
use and silence hold. It is a layer above the gate, not a replacement for it.

## Claim leases (implemented)

A claim is mutual exclusion, not a record that work happened — the immutable
receipt is that record. A lease must therefore release on **expiry or
identity**:

- expiry, so a dead worker cannot hold a lease forever
- identity, so a worker retrying its own operation is not treated as a rival

The old guard had only expiry, and the lease was set 24 hours out while the
promoter retried every two minutes, so in practice it had neither. A run that
died after claiming produced `already claimed by preview-deployer` against
`preview-deployer` itself.

`gateway/lib/deployment-claims.js` implements both. An anonymous claimant — one
that offers no worker id and claim id — is still treated as contention, so any
caller that does not identify itself keeps the old, stricter behaviour.

Leases should also be minutes, not a day. A 24-hour lease on a two-minute retry
loop is a freeze, not a lease. Changing the value is a follow-up task because
it touches the promoter's evidence contract, not the store.
