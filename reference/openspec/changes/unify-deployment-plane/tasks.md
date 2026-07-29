## 0. Unblock Production (done in this change)

- [x] 0.1 Make OTA directory creation best-effort at gateway boot.
      `gateway/lib/android-ota.js` exports `ensurePublisherOwnedDir`, which
      returns `{dir, ready, reason}` and rethrows anything that is not
      EACCES/EPERM. `gateway/server.js` uses it for `ANDROID_OTA_DIR` and every
      channel directory.
      Acceptance: a channel directory the gateway user cannot traverse leaves
      the gateway serving and logs the reason; a non-permission failure still
      throws. Covered in `gateway/test/android-ota.test.js`.
- [x] 0.2 Release a deployment claim on lease expiry **or** matching claimant
      identity. `gateway/lib/deployment-claims.js` holds
      `currentDeploymentClaim`, `isClaimExpired` and `isClaimHeldByOther`;
      `assertDeploymentOperationClaimable` takes the claimant and
      `claimDeploymentRequest` passes it.
      Acceptance: the same worker re-presenting the same claim id is admitted;
      a different worker or claim id is rejected; an expired lease is
      reclaimable by anyone; an anonymous claimant is still treated as
      contention. Covered in `gateway/test/deployment-claims.test.js`.

## 1. Stop The Surfaces Sharing A Filesystem

- [ ] 1.1 Give the Android OTA store its own Docker volume and mount it
      read-only into the gateway. The publisher writes it; the gateway serves
      from it and creates nothing in it.
      Acceptance: `docker inspect` shows the OTA mount as read-only for the
      gateway, and a publish still passes its public verification step.
- [ ] 1.2 Exclude the OTA store from the gateway DATA_DIR backup once it has
      its own volume, and back it up on its own schedule.
      Acceptance: a gateway backup no longer contains `android-ota/`, and its
      size drops accordingly; the OTA store still has a restorable copy.
- [ ] 1.3 If 1.1 is deferred, make `android_app/deploy/ota/sync-vps.sh` chown
      everything it creates to the gateway's uid.
      Acceptance: after a publish, no path under the OTA store is unreadable
      by the gateway user.
- [ ] 1.4 Add a boot-time audit line reporting OTA store ownership drift.
      Acceptance: a store containing a path the gateway cannot read is visible
      at `/health` without reading container logs.

## 2. Keep Deployment Identity Through Rollback

- [ ] 2.1 Pass `MOA_BUILD_SHA`, `MOA_BUILD_REF` and `MOA_BUILD_TIME` in
      `rollback_gateway()` at `scripts/vps/update.sh:53`, matching the forward
      path at lines 181-184.
      Acceptance: after a forced rollback in the update-rollback test,
      `/health` reports the restored commit and not `unknown`.
- [ ] 2.2 Extend `scripts/vps/test-update-rollback.sh` to assert the reported
      build sha after rollback.
      Acceptance: the test fails against the current rollback path and passes
      after 2.1.

## 3. Retention

- [ ] 3.1 Replace count-based backup retention in `scripts/vps/backup.sh` with
      age-based retention: all for 7 days, daily for 30, monthly off-host.
      Acceptance: a simulated day of failed promotions prunes no scheduled
      backup.
- [ ] 3.2 Tag backups with a reason (`promotion` or `scheduled`) and prune
      promotion backups aggressively without letting them evict scheduled ones.
      Acceptance: the manifest carries the reason and the prune honours it.
- [ ] 3.3 Refuse to prune a backup that the off-host mirror has not taken.
      Acceptance: pruning with no mirror record leaves the backup in place and
      logs why.
- [ ] 3.4 Delete the unrestorable `20260706T084805Z` backup (0-byte dump) and
      make the prune report incomplete backups instead of skipping them
      silently.
      Acceptance: incomplete backups are named in the prune output.
- [ ] 3.5 Prune gateway images, preview worktrees and evidence JSON to the
      running version plus one predecessor after a successful promotion.
      Acceptance: after two promotions, at most two gateway images and one
      preview directory remain; evidence rows in Postgres are untouched.
- [ ] 3.6 Prune Android releases and publish snapshots to `current` plus one.
      Acceptance: `releases/` holds two entries after two publishes and the
      rollback target still resolves.

## 4. The Plane

- [ ] 4.1 Add the `surface_version` event stream and projection to the
      release-control database.
      Acceptance: state transitions are appended as events and the current row
      is rebuildable from the log alone.
- [ ] 4.2 Record `rolling_out` on apply and `active` once post-apply health
      holds, for the gateway.
      Acceptance: a promotion leaves exactly one `active` gateway row naming
      the applied commit.
- [ ] 4.3 Report Android `rolling_out` on publish and `active` when the phone
      reports the new version, preserving the published-vs-installed
      distinction.
      Acceptance: a publish with no phone connected leaves the version
      `rolling_out`, never `active`.
- [ ] 4.4 Report extension `rolling_out` on package and `active` when the
      loaded extension polls the new version.
      Acceptance: an unverified reload leaves the version `rolling_out`.
- [ ] 4.5 Expose one read endpoint returning every surface's state.
      Acceptance: one call answers running, confirmed, rolling out, and failed
      for all three surfaces.

## 5. Confirmation And Complaints

- [ ] 5.1 Count qualifying interactions per active version, excluding health
      checks, CI probes and preview traffic.
      Acceptance: preview and health traffic move no counter.
- [ ] 5.2 Promote `active` to `confirmed` only on time, use and silence
      together.
      Acceptance: a version with 24 hours and silence but no use stays
      `active`.
- [ ] 5.3 Classify a turn as a complaint about the agent's own behaviour, mark
      the active version `suspect`, and record the turn id.
      Acceptance: frustration not aimed at the agent records nothing; a
      recorded complaint names the turn that caused it.
- [ ] 5.4 Mark a version `suspect` automatically on crash loop or error-rate
      spike.
      Acceptance: a container restarting repeatedly marks its version
      `suspect` within a minute.
- [ ] 5.5 Resolve rollback to the newest `confirmed` version, refusing when
      none exists.
      Acceptance: with no confirmed version, rollback refuses and states why
      instead of using the previous version.
- [ ] 5.6 Shorten the promotion claim lease from 24 hours to minutes in
      `scripts/vps/create-promotion-evidence.js`.
      Acceptance: a lease outlives a normal promotion and expires well inside
      the retry cadence.

## 6. Documentation

- [ ] 6.1 Remove or correct `deploy_gateway()` at `scripts/deploy.sh:151-170`,
      which targets the decommissioned main machine.
      Acceptance: no document lists a gateway promotion command that cannot
      promote the gateway.
- [ ] 6.2 Update `DEPLOYMENT.md` and `AGENTS.md` with the plane, the two
      retention policies, and the confirmed-version model.
      Acceptance: the retention rules for artifacts and for backups are stated
      separately and cannot be confused.
