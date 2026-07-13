# Final deployment/evidence repair contract

Base: `caba6a1`. Branch/worktree:
`agent/deploy-evidence-final-repair` / `chief-moa-worktrees/deploy-evidence-final-repair`.

Objective: make whole-portfolio quality evidence reproducible and remove every
known path that can turn ordinary CI success into active deployment authority.

Non-negotiables:

- run all discovered gateway tests without `MOA_SKIP_SLOW` plus complete Swift
  and Rust package suites; focused M4/MB/M6/Aggie/context gates supplement them;
- disposable Postgres must be newly created and non-production; absence of a
  local engine is a recorded skip, never a source-level pass;
- exact candidate commit, approved M4 review, verified isolated preview,
  current preview/apply claims, separate database/queue/storage/worker pool,
  drain/resume, compatibility, backup/restore, rollback and post-smoke evidence
  are required before mutation;
- backup/restore cannot be skipped; failed post-apply smoke rolls back;
- CI produces candidate evidence only and cannot advance the active ref;
- no live promotion from this lane.

Owned paths: `scripts/final-portfolio-quality-gate.sh`,
`scripts/disposable-postgres-evidence.sh`, `scripts/vps/update.sh`, deployment
evidence helpers/tests, `.github/workflows/deploy-vps.yml`, Windows workflow
action pins, this contract and current-head evidence ledgers.

Acceptance commands:

```sh
node scripts/vps/test-promotion-evidence.js
bash -n scripts/vps/update.sh scripts/final-portfolio-quality-gate.sh scripts/disposable-postgres-evidence.sh
scripts/final-portfolio-quality-gate.sh
scripts/disposable-postgres-evidence.sh # pass, or exit 77 with an explicit environmental skip
git diff --check
```

Audit blockers: any ordinary CI-to-active-ref path, optional backup, mutable
action reference, hand-picked test subset presented as broad proof, forged or
cross-commit evidence, shared preview resource, failed-smoke success receipt,
or unsupported preview/production claim.

