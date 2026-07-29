# The deployment plane

Audit of how chief-moa ships code today, why promotion keeps failing, and the
structure that replaces it. Written 2026-07-29 against the live droplet
(`root@143.198.226.83`, read-only) and the tree at
`feat/deployment-architecture-audit-20260729`.

## Summary

The user's complaint is correct. There are three deployment mechanisms. They
were designed separately, they store artifacts differently, they retain
artifacts differently, and they require different evidence. Two of them share
one directory with incompatible file ownership, and on 2026-07-29 that
collision took production down.

This document records what each mechanism does, proves the failures from logs,
and specifies one plane to replace them.

## 1. What actually ships, per surface

### 1.1 Gateway — pull promotion off a git ref

The only surface with a real promotion gate.

| Stage | Where |
|---|---|
| Move master | `scripts/release/push-master.sh` — pushes the branch, opens a PR, waits for green, then fast-forwards master |
| Verify + publish ref | `.github/workflows/deploy-vps.yml:99-129` — fast-forwards `refs/heads/vps-deploy` to the verified SHA |
| Notice the move | `scripts/vps/auto-update.sh:26-39` — systemd timer, `flock`, compares `origin/vps-deploy` to the deployed checkout |
| Preview + evidence | `scripts/vps/promote-candidate.sh` — isolated Compose project, own volumes, own ports, TLS proxy, auth gate, restore-check |
| Apply | `scripts/vps/update.sh` — backup, restore-check, drain check, checkout, rebuild, health, Caddy reload, receipt |

Artifacts live on the droplet: a Docker image built in place, a preview
worktree under `/opt/chief-moa/previews/<sha12>`, and an evidence JSON under
`/opt/chief-moa/promotion-evidence/<sha>.json`.

Evidence required: the full M4 chain — request, review, preview claim, preview
deployment, preview verification, apply claim, observed effect, immutable
receipt — recorded in the gateway's own Postgres via
`scripts/vps/create-promotion-evidence.js`.

Retention: **none.** Nothing prunes images, previews, or evidence files.
Observed: 31 preview directories, 21 evidence files, and 27 gateway images
before they were pruned by hand today.

`scripts/deploy.sh gateway` is **dead code** for production. `deploy_gateway()`
at `scripts/deploy.sh:151-170` rsyncs to `$REMOTE`/`$REMOTE_GW_DIR` and calls
`gateway/deploy/main-machine/sync-when-online.sh` — the decommissioned main
machine. With the target unset it returns 75 and logs "use the CI verified
vps-deploy path". `DEPLOYMENT.md` and `AGENTS.md` both list it as an active
promotion command. It cannot promote the production gateway.

### 1.2 Android OTA — push publication over SSH

The inverse design: the developer's Mac pushes bytes to the droplet.

`scripts/deploy.sh android` (`scripts/deploy.sh:172-222`) captures a clean
candidate, builds a timestamp-versioned debug APK with the local continuity
key, then runs `android_app/deploy/ota/sync-vps.sh` (999 lines) to publish.

Publication is a real transaction: `.publish-lock`, a snapshot of the prior
`current` into `.publish-snapshots/`, private staging under
`.publish-staging/`, atomic `current` swap last, then public verification
through the running gateway container, then a receipt.

The store is a directory **inside the gateway's data volume**:
`/data/android-ota` in `chief-moa_moa-gateway-data`.

Retention: **never deletes.** `DEPLOYMENT.md:146` states it outright —
"publication itself never deletes rollback evidence." Observed on the droplet:
33 release directories, 36 publish snapshots, plus `.publish-locks-recovered/`
and a `.publish-recovered-20260727T214319Z/` tree.

Evidence required: lock, snapshot, staged-byte re-verification, public manifest
and APK match on release id, version, size and SHA-256, then acknowledgement.
Strong, and entirely unrelated to the gateway's M4 chain.

### 1.3 Browser extension — local package, no remote artifact

`deploy_extension()` at `scripts/deploy.sh:307-321` runs verify, smoke,
package, and `deploy:browser`, which pokes the loaded unpacked extension to
reload. Nothing is published to a server.

`.github/workflows/browser-extension-release.yml` optionally submits to the
Chrome Web Store and uploads a build artifact with `retention-days: 30`.

Retention: GitHub's 30 days for the CI artifact; nothing locally.

Evidence required: a manifest version bump, verify, smoke, and a reload that is
only reported successful when the loaded extension polls again.

### 1.4 The verdict

Three mechanisms:

| | Gateway | Android OTA | Extension |
|---|---|---|---|
| Direction | pull (droplet fetches) | push (Mac sends) | local only |
| Artifact store | droplet Docker + worktrees | gateway data volume | none |
| Retention | none | never delete | 30d in CI |
| Evidence | M4 event chain in Postgres | lock/snapshot/receipt on disk | version bump + reload poll |
| Rollback | git ref + rebuild | republish older bytes | reinstall |
| Version of record | `/health` `build.git_sha` | `latest.json` | `manifest.json` |

There is no place that knows all three. Nothing correlates them. They share
only one thing, and that one thing is the bug.

## 2. Why promotion kept failing

Resource exhaustion was real and is fixed (4 GB swap, disk 98% → 64%). It was
not the whole story. From `journalctl -u chief-moa-auto-update.service`, five
days:

    39  status=1     37 of them: restore-check usage error
     4  status=2     tar failures
     1  status=137   OOM
     1  status=28    curl timeout
     1  status=15    SIGTERM

### 2.1 The ownership collision — the outage

At 05:17 UTC on 2026-07-29 the Android OTA publisher created
`/data/android-ota/channels` as **root, mode 0700**, inside the gateway's data
volume. The gateway container runs as `node`, uid 1000.

`gateway/server.js:352` ran this at module top level:

    for (const channelDir of Object.values(ANDROID_OTA_CHANNELS)) fs.mkdirSync(channelDir, { recursive: true });

uid 1000 cannot traverse a root-owned 0700 directory, so:

    Error: EACCES: permission denied, mkdir '/data/android-ota/channels/ag.companion'
        at Object.<anonymous> (/app/server.js:352:66)

Thrown at top level, this kills the process. The container entered
`Restarting (1)`, and `https://api.agee.app/health` returned 502 for roughly
half an hour until `update.sh`'s automatic rollback restored `cfdb881b`.

Ownership across the volume, from `ls -lan`:

    drwxr-xr-x 24 1000 1000  .              gateway data
    drwxr-xr-x  8  501   50  android-ota    the dev Mac's uid, arriving via rsync
    drwx------  3    0    0  channels       root, 0700, publisher-created

Three uids in one volume: the gateway's container user, the developer's macOS
uid carried over by `rsync`, and root from SSH commands.

### 2.2 The same collision broke the promotion gate first

`scripts/vps/backup.sh:61` tars `/data` as container root and tolerates tar
exit 1 but fails on exit 2. Four promotion runs died here:

    tar: ./android-ota/.publish-staging: Cannot open: Permission denied
    tar: Exiting with failure status due to previous errors
    DATA_DIR snapshot failed (tar exit 2).

`.publish-staging` is `drwx------ root`. The Android publisher's private
staging directory blocks the gateway's backup, and no backup means no
promotion. The comment at `backup.sh:52-55` already acknowledges the shared
volume; it does not survive mode 0700.

### 2.3 The claim that only its own retry could clear

Seen once in five days, but deterministic once a run dies after claiming.

`scripts/vps/create-promotion-evidence.js` derives everything from the commit:
the request is idempotent on `source_turn_id: vps-promotion-<sha12>`
(`work-history.js:628`), and the claim id is `preview-<sha12>` (line 47). A
retry of the same commit therefore presents the same request, the same worker,
and the same claim id.

`assertDeploymentOperationClaimable` rejected any unexpired claim without
asking who was asking:

    if (currentClaim && !isClaimExpired(currentClaim) && !entry.receipts.get(operation)) {
      throw new Error(`... ${operation} is already claimed by ${currentClaim.worker_id}`);
    }

So the retry was refused by its own earlier claim:

    POST /v1/work-history/deployments/requests/dreq_.../claim returned HTTP 400:
    preview is already claimed by preview-deployer

Lease expiry **was** honoured — `isClaimExpired` is checked here and at
`work-history.js:1473` and `:1947`. The lease was simply useless: it is set 24
hours out (`create-promotion-evidence.js:52`) while the timer retries every two
minutes. The clock could not clear the claim for a day, and identity was never
consulted.

This is the same shape as the OTA publish lock that could strand its own store.
A lease must release on expiry **or** on identity. It had only expiry, set too
far out to matter.

### 2.4 Rollback erases deployment identity

`update.sh:181-184` builds forward with `MOA_BUILD_SHA`, `MOA_BUILD_REF` and
`MOA_BUILD_TIME`. `rollback_gateway()` at `update.sh:53` runs a bare
`compose build gateway`.

After today's rollback, production reports:

    {"ok":true,"build":{"git_sha":"unknown","git_ref":"unknown","built_at":"unknown"}}

The gateway is healthy and serving, and nothing can tell which commit it runs.
`deploy-vps.yml`'s "Wait for exact commit at active gateway" job can never
match after a rollback. The one field that answers "what version is production
on" is destroyed by the recovery path.

### 2.5 Promotion retries are eating the backups

Every attempt calls `backup.sh`, which writes ~1.3 GB and prunes to
`MOA_BACKUP_RETENTION=14` (`backup.sh:106-137`).

Observed: **66 prune events in five days.** 14 of the 15 backups on disk are
from the last 30 hours of failed retries. A 14-deep window is now about five
hours of wall clock, not 14 days. The one older survivor,
`20260706T084805Z`, is a 0-byte `postgres-dump.sql` that survives only because
the prune skips incomplete backups — it is unrestorable and immortal.

Failed deployments are deleting the user's backup history. This is the most
dangerous finding in the audit and it is a direct consequence of retention
being counted in backups rather than in time.

### 2.6 Hosted runners were paid to poll an unreachable endpoint

The master-push workflow started a separate Ubuntu runner after publishing
`vps-deploy` and polled public `/health` for up to 40 minutes. Failed run
`30430079790` spent the whole window with `observed=unavailable`, even though
the endpoint was readable from an ordinary operator client. This was not
candidate verification or promotion work; it was a sleeping network observer.

Live observation now runs from `scripts/release/push-master.sh` through
`scripts/vps/wait-for-live-commit.sh`. GitHub still verifies the exact tree and
publishes only that SHA. The operator process, which can reach the public
endpoint and consumes no hosted-runner minutes, waits for the exact active
commit. CI concurrency is scoped by event and ref and cancels stale runs, so a
new commit does not queue obsolete verification behind it.

## 3. Retention

The user said to stop keeping deployment versions and rebuild as needed. That
is right for artifacts and wrong for backups, and the two are currently tangled
in the same directory tree and the same prune loop.

### 3.1 Deployment artifacts — disposable

Keep the running version and exactly one predecessor. Rebuild anything else.

| Artifact | Keep | Rebuild cost |
|---|---|---|
| Gateway Docker image | running + 1 | ~13 min image build on this box |
| Preview worktree | current candidate only | seconds (`git worktree add`) |
| Promotion evidence JSON | current + 1 | cannot rebuild — see below |
| Android release dir | `current` + 1 | full APK rebuild on the Mac, minutes, and it needs the continuity key |
| Publish snapshot | 1 | n/a, it is the predecessor |

Rolling back one step is free: the predecessor image is on disk. Rolling back
two or more steps means a rebuild. On this droplet that is about 13 minutes for
the gateway image plus roughly 8 minutes for backup and restore-check, so call
it **20-25 minutes to reach an arbitrary older gateway version**, versus under
a minute for one step back. That is the honest price of the user's instruction,
and for a single-user product it is the right trade: 25 minutes of recovery
once in a while beats 8 GB of permanently parked images.

Promotion evidence is the exception. It is not an artifact, it is the record
that the gate was passed, and it cannot be regenerated after the fact without
fabricating it. Keep evidence in Postgres, where it already lives, and treat
the JSON files as a cache that prunes to current + 1.

### 3.2 Backups — user data, a separate policy

Backups hold voice turns, conversations, audio notes, brain facts and both
Postgres databases. They are the only copy of things the user cannot recreate.
They are not deployment versions and the instruction to delete deployment
versions does not reach them.

Recommended policy, replacing count-based retention:

- Keep every backup for **7 days**, regardless of how many promotions ran.
- Keep one backup per day for **30 days**.
- Keep one per month indefinitely, off-host.
- Cap the on-host total by **age, never by count**, so a retry storm cannot
  evict history.
- Never let a promotion's backup count against the retention of a scheduled
  one. Tag them: `reason=promotion` prunes aggressively, `reason=scheduled`
  does not.
- `scripts/vps/pull-backups.sh` already mirrors off-host. Off-host is the copy
  that matters; verify it before trusting any on-host prune.

Today the droplet holds 16 GB of backups against 18 GB free. Under this policy
the promotion backups collapse to one or two and the daily history fits.

## 4. The confirmed-version model

The user's idea: a release is good if they use it and do not complain.

That is sound, and it needs one guard. Absence of complaint is only evidence
if there was an opportunity to complain. A release nobody exercised is not
confirmed, it is untested, and treating silence on an unused release as
approval is how a broken version becomes the rollback target.

So confirmation requires **use plus silence**, never silence alone.

### 4.1 States

    building -> previewed -> rolling_out -> active -> confirmed
                                              |
                                              +-> suspect -> rolled_back

- `active`: applied, healthy, not yet trusted.
- `confirmed`: applied, exercised, and not complained about.
- `suspect`: a complaint or a health signal landed against it.

### 4.2 What confirms a version

All three must hold:

1. **Time.** At least 24 hours as `active`.
2. **Use.** A per-surface exercise threshold met while it was active — for the
   gateway, N successful voice turns from a real device; for Android, the app
   opened and completed a turn; for the extension, an overlay interaction.
   Requests from health checks and CI do not count.
3. **Silence.** No complaint recorded in the window.

Miss any one and the version stays `active` forever. `active` is a normal
resting state, not a failure. It simply never becomes a rollback target.

Rollback goes to the newest `confirmed` version. If none exists, rollback
refuses and says so rather than guessing.

### 4.3 What a complaint is

The user talks to the agent all day, so the cheapest signal is the one they
already produce. A complaint is any of:

- **Spoken.** The agent classifies a turn as a complaint about its own
  behaviour — "you're broken", "why didn't that work", "stop doing that",
  "it's not responding". This is the primary input.
- **Explicit.** "Roll back", "go back to yesterday's version."
- **Automatic.** Error-rate or crash-loop signals against the active version.

A complaint marks the active version `suspect` and starts a rollback
conversation. It does not roll back on its own — a single frustrated sentence
is not a deployment decision.

Guard against the obvious failure: a complaint about the weather is not a
complaint about the deployment. Classification must be scoped to the agent's
own behaviour, and every complaint that moves a version to `suspect` must be
recorded with the turn that caused it, so a wrong classification is visible and
reversible.

### 4.4 The failure this avoids

Ship v2 on a Friday. The user does not touch the product all weekend. Monday
they use it and it is broken.

Count-the-silence would have confirmed v2 on Saturday and made it the rollback
target, so Monday's rollback lands on the broken version. Requiring use means
v2 sat at `active` all weekend, the last `confirmed` version is still v1, and
Monday's rollback goes somewhere that works.

## 5. One deployment plane

One record per surface per version, in the gateway's existing Postgres release
control database, so the M4 chain and the confirmation state share a store.

    surface     gateway | android | extension
    version     commit sha, or release id for Android
    state       building|previewed|rolling_out|active|confirmed|suspect|rolled_back
    since       when it entered that state
    evidence    the M4 request id, or the OTA receipt id
    use_count   qualifying interactions while active
    complaints  turn ids that marked it suspect

One endpoint answers the user's question — what is each surface on, what is
confirmed, what is rolling out, what failed — and one command rolls a surface
back to its last confirmed version.

Rules:

1. **The plane records, it does not relax.** Backup and restore-check still run
   before the active service is touched. The M4 chain still gates apply. This
   change adds a state machine and a retention policy; it removes no check.
2. **Every surface reports the same way.** Android and the extension get the
   same state transitions the gateway already has, even though their transports
   differ. Publishing an APK writes `rolling_out` and the phone confirming the
   install writes `active` — which is the published-vs-installed distinction
   `DEPLOYMENT.md:113-123` already insists on, made machine-readable.
3. **Surfaces stop sharing a filesystem.** The OTA store moves out of the
   gateway's data volume, or the publisher writes as the gateway's uid. Either
   fixes the outage class; the first also stops OTA snapshots being tarred into
   every gateway backup, which is most of the 1.3 GB.
4. **Identity survives rollback.** The rollback path passes the same
   `MOA_BUILD_*` variables as the forward path, so `/health` always names the
   running commit.
5. **Leases release on expiry or identity.** Implemented — see
   `gateway/lib/deployment-claims.js`.

## 6. Fixed in this change

Two bugs, both small, both proven above.

- `gateway/lib/android-ota.js` — `ensurePublisherOwnedDir` makes OTA directory
  creation best-effort. EACCES/EPERM degrades the channel; anything else still
  throws. `gateway/server.js` uses it, so a publisher-owned directory can no
  longer kill the gateway at boot. This is the outage.
- `gateway/lib/deployment-claims.js` — `isClaimHeldByOther` releases a lease on
  expiry **or** on matching claimant identity, so a crashed run's own retry is
  admitted while other workers are still excluded.

Everything else in this document is design, specified under
`reference/openspec/changes/unify-deployment-plane/`.
