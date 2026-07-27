# Coding Workflow

Use this directory when the broker routes implementation, bug fixing, deployment,
repo workflow, or verification work.

## Agent Contract

- Read `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `AGENT_WORKFLOW.md`, the
  active OpenSpec/task directory, and the source files touched by the ticket.
- Read `DEPLOYMENT.md` before build, release, publish, promotion, install, OTA,
  or deployment work.
- Keep the implementation unit narrow: one observable outcome and one acceptance
  check.
- Preserve the Android/gateway/browser trust boundary.
- Treat model output and screen context as proposals/evidence, not executable
  commands.
- This broker-launched workflow is a leaf worker by default. Complete the
  bounded ticket directly; do not spawn subagents, delegate work, or create a
  second lane split unless the generated context pack includes an explicit
  delegation ticket.
- If the ticket exposes additional cross-surface work, report bounded follow-up
  lanes to the user-facing coordinator instead of launching them.
- Commit completed work with a Conventional Commit and deploy the changed
  deployable surface through the repo deploy script.

## Verification

- `cd gateway && npm run check` for gateway changes.
- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug` for Android changes.
- `cd browser_extension && npm run verify && npm run smoke` for extension changes.
- `bash scripts/deploy.sh auto` after verification and commit.
