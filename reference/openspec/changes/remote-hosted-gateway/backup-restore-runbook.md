# Backup And Restore Promotion Gate

This is the required safety lane before any VPS promotion that changes the
active URL, restarts the active gateway service, applies a Master Orch
deployment, or otherwise points users at a new active Chief Moa gateway.

The scripts in this lane are intentionally separate from `scripts/deploy.sh`.
They never read `.env`, never print database URLs, never restart the active
service, and never apply a deployment. Promotion remains a human gate.

## Backup Script

Script: `scripts/vps-backup.sh`

Required env:

- `MOA_BACKUP_DIR`: caller-provided directory where a timestamped backup
  directory is written.
- `MOA_BACKUP_DATABASE_URL`: active Postgres connection URL. This is secret
  material and must be supplied through the shell environment, not committed,
  logged, or passed in chat.
- `MOA_BACKUP_DATA_DIR`: active gateway `DATA_DIR` path to snapshot.

Optional env:

- `MOA_BACKUP_REMOTE`: SSH target for a remote `DATA_DIR` rsync, for example
  `deploy@vps.example.com`. Omit it when running on the VPS or when
  `MOA_BACKUP_DATA_DIR` is local.
- `MOA_BACKUP_LABEL`: backup label suffix. Default: `pre-promotion`.
- `MOA_BACKUP_RSYNC_RSH`: remote shell for `rsync`. Default:
  `ssh -o BatchMode=yes`, so remote snapshots fail instead of prompting for a
  password.
- `MOA_BACKUP_PG_DUMP_BIN`, `MOA_BACKUP_TAR_BIN`, `MOA_BACKUP_GZIP_BIN`,
  `MOA_BACKUP_RSYNC_BIN`, `MOA_BACKUP_SHASUM_BIN`: tool overrides.

Dry-run:

```sh
MOA_BACKUP_DIR=/operator/backups/moa \
MOA_BACKUP_DATABASE_URL='postgres://...' \
MOA_BACKUP_DATA_DIR=/srv/moa/data \
scripts/vps-backup.sh --dry-run
```

Execute:

```sh
MOA_BACKUP_DIR=/operator/backups/moa \
MOA_BACKUP_DATABASE_URL='postgres://...' \
MOA_BACKUP_DATA_DIR=/srv/moa/data \
MOA_BACKUP_LABEL=before-vps-promotion \
scripts/vps-backup.sh --execute
```

Remote `DATA_DIR` snapshot from an operator machine:

```sh
MOA_BACKUP_DIR=/operator/backups/moa \
MOA_BACKUP_DATABASE_URL='postgres://...' \
MOA_BACKUP_REMOTE=deploy@vps.example.com \
MOA_BACKUP_DATA_DIR=/srv/moa/data \
scripts/vps-backup.sh --execute
```

Artifacts:

- `postgres.sql.gz`: gzip-compressed plain `pg_dump` output.
- `data-dir.tar.gz`: tar snapshot of `DATA_DIR`.
- `SHA256SUMS`: checksums for the dump and snapshot.
- `manifest.txt`: non-secret metadata only.

## Restore Check Script

Script: `scripts/vps-restore-check.sh`

Required env:

- `MOA_RESTORE_BACKUP_DIR`: one timestamped directory produced by
  `scripts/vps-backup.sh`.
- `MOA_RESTORE_DATABASE_URL`: empty scratch Postgres database URL. It must not
  point at the active database.
- `MOA_RESTORE_SCRATCH_DIR`: new local scratch directory for restored `DATA_DIR`,
  logs, and health output. The path must not already exist.
- `MOA_RESTORE_GATEWAY_PORT`: non-active localhost port for the scratch gateway.
  The script rejects `8787`.
- `MOA_RESTORE_CONFIRM_SCRATCH=RESTORE_CHECK_ONLY`: explicit confirmation that
  the target is scratch-only.

Optional env:

- `MOA_RESTORE_CORE_TABLE`: table checked after restore. Default:
  `product_events`.
- `MOA_RESTORE_ALLOW_UNLABELED_DATABASE=1`: allow a scratch database URL that
  does not visibly include `scratch`, `restore`, `tmp`, or `test`, only after
  manual operator verification.
- `MOA_RESTORE_PSQL_BIN`, `MOA_RESTORE_TAR_BIN`, `MOA_RESTORE_GZIP_BIN`,
  `MOA_RESTORE_CURL_BIN`, `MOA_RESTORE_NODE_BIN`: tool overrides.

Dry-run:

```sh
MOA_RESTORE_BACKUP_DIR=/operator/backups/moa/20260703T120000Z-before-vps-promotion \
MOA_RESTORE_DATABASE_URL='postgres://.../moa_restore_check' \
MOA_RESTORE_SCRATCH_DIR=/tmp/moa-restore-check-20260703 \
MOA_RESTORE_GATEWAY_PORT=18787 \
MOA_RESTORE_CONFIRM_SCRATCH=RESTORE_CHECK_ONLY \
scripts/vps-restore-check.sh --dry-run
```

Execute:

```sh
MOA_RESTORE_BACKUP_DIR=/operator/backups/moa/20260703T120000Z-before-vps-promotion \
MOA_RESTORE_DATABASE_URL='postgres://.../moa_restore_check' \
MOA_RESTORE_SCRATCH_DIR=/tmp/moa-restore-check-20260703 \
MOA_RESTORE_GATEWAY_PORT=18787 \
MOA_RESTORE_CONFIRM_SCRATCH=RESTORE_CHECK_ONLY \
scripts/vps-restore-check.sh --execute
```

The restore check:

1. Refuses to run unless the scratch directory is new.
2. Refuses to restore unless the scratch database has zero public tables.
3. Restores the Postgres dump into the scratch database.
4. Restores the `DATA_DIR` snapshot into the scratch directory.
5. Runs the core table query against the scratch database.
6. Starts `gateway/server.js` directly with `env -i`, `HOST=127.0.0.1`, the
   scratch `DATA_DIR`, and the scratch `DATABASE_URL`.
7. Requires `GET http://127.0.0.1:$MOA_RESTORE_GATEWAY_PORT/health` to pass.

The script does not call `npm start`, so it does not use Node's
`--env-file-if-exists=.env` path. It also sets `HOME` to the scratch directory
for the health run so gateway status checks do not inspect user credential
files.

## Promotion Gate Sequence

Use this exact sequence before any active VPS promotion:

1. Freeze active-app mutation for the maintenance window. Do not restart the
   active gateway, apply a deployment, change DNS, change the active URL, run
   migrations against the active database, or switch Master Orch `applyTo`.
2. Verify the candidate in an isolated preview path. The preview may use a
   separate branch, worktree, image tag, compose project, or preview deployment,
   but it must not be the active user URL.
3. Prepare a backup destination owned by the operator.
4. Run `scripts/vps-backup.sh --dry-run` with the explicit `MOA_BACKUP_*` env.
   Stop if the dry-run reports blockers.
5. Run `scripts/vps-backup.sh --execute`.
6. Provision an empty scratch Postgres database and a new scratch directory.
   These must be separate from the active database and active `DATA_DIR`.
7. Run `scripts/vps-restore-check.sh --dry-run` with the explicit
   `MOA_RESTORE_*` env. Stop if the dry-run reports blockers.
8. Run `scripts/vps-restore-check.sh --execute`.
9. Record the backup directory, restore scratch directory, health URL, and any
   blocker in the promotion notes.
10. Only after the backup and restore check pass may the human operator promote:
    apply the deployment, restart the active service, or change the active URL
    through the approved deployment control plane.
11. Smoke-check the active gateway after promotion with `GET /health` and the
    smallest user-facing API check relevant to the release.

## Blockers

Promotion is blocked when any of these are true:

- `pg_dump`, `psql`, `tar`, `gzip`, `curl`, `node`, `shasum`, or required remote
  copy tooling is unavailable.
- The scripts would need to read `.env` or a credential file to connect.
- The restore target is not visibly scratch-only.
- The scratch database is not empty.
- The scratch gateway cannot answer `/health`.
- The backup or restore command prints or requires pasting secrets into logs.
- The candidate has not been verified in an isolated preview path.

When blocked, do not promote. Fix the tooling or scratch target first, then rerun
the dry-run and execute steps.
