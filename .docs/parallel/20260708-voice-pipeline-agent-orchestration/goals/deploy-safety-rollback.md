# Goal: deploy-safety-rollback

Branch: read-only
Worktree: current checkout or assigned read-only workspace

## Goal

Audit the deployment and rollback path for gateway voice changes under the
project's live-app safety rules. Determine what evidence is required before
promoting changes that may drop active voice sockets.

## Target Files

Read only:

- `scripts/deploy.sh`
- `scripts/vps/update.sh`
- `scripts/vps/auto-update.sh`
- `.github/workflows/*`
- `gateway/deploy/vps/README.md`
- `reference/openspec/changes/remote-hosted-gateway/*`
- `AGENTS.md`

## Acceptance Criteria

- Report the current gateway promotion path and rollback path.
- State exactly what would prove no active recording/voice turn/session is
  interrupted, or what blocker remains.
- Define preview/smoke evidence for this voice work.
- Do not deploy.

## Do Not Touch

No file edits. No deploy/push/restart commands.

