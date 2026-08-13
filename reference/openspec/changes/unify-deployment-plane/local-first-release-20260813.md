# Local-first release simplification — 2026-08-13

This record supersedes the GitHub-runner release mechanics described in the
2026-07-29 deployment-plane audit. It does not erase that historical evidence.

## Removed runner coupling

- Android verify/upload/manual-publish workflow.
- Gateway verify/ref-publication workflow and its workflow-contract test.
- Browser extension verify/upload/store-publication workflow.
- macOS QA artifact workflow.
- Cross-surface release-evidence workflow.
- VPS runner-based read-only audit workflow.
- PR/check-waiting behavior in `scripts/release/push-master.sh`.

The source-size and Windows workflows remain because they are unrelated
verification lanes and are not release authority.

Read-only GitHub inspection on 2026-08-13 showed Actions globally enabled and
all seven release workflows still active on remote `master`; they remain so
until this deletion candidate is integrated. Their historical runs are retained.
GitHub returned HTTP 403 for both branch-protection and repository-ruleset
inspection with the message that the private repository requires GitHub Pro or
public visibility for those features. No required-check rule could therefore be
enumerated or changed in this lane. The direct push will still fail closed if an
external repository policy rejects it.

## Local release contract

`scripts/release/local-release.sh` runs the exact surface tests, creates the
surface package, computes its SHA-256, and writes a receipt beneath Git's shared
`chief-moa-local-releases/` directory. It has no SSH, rsync, ADB, browser reload,
GitHub CLI, service restart, or publication behavior.

`scripts/deploy.sh <target>` is local-only by default. Remote publication or
an installed-browser reload requires both:

```text
--direct-deploy --target chief-moa-production
```

The configured identity comes from `scripts/deploy-targets.json`; a missing or
different identity fails before the local release gate or network effects.
Android retains clean-tree and stable-lineage checks, the continuity signer,
immutable release directories, rollback snapshots, public digest verification,
and publication receipts. The local Android gate verifies the exact APK signer
against `production.android_signer_sha256` before writing its receipt. Gateway promotion retains preview, drain,
compatibility, rollback, and health gates. Browser promotion retains version,
package, and reload-poll checks.

Master integration uses
`scripts/release/push-master.sh --direct-push --target master`. It runs affected
release gates locally, pins one full candidate SHA, rechecks origin/master after
verification, and performs only a fast-forward push. It does not create a PR or
call GitHub Actions.

## External state left untouched

No live service, OTA head, phone, installed application, credential, production
data, Git history, existing release artifact, external workflow history, or
repository protection setting was changed by this implementation lane. The
seven remote workflow records were not disabled ahead of integration because
that would race the active deployment lane; deleting their tracked definitions
stops future triggers once the parent integrates this candidate.
