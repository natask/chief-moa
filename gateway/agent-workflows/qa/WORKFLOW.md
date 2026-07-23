# QA Workflow

Use this directory when the broker routes testing, validation, smoke checks,
regressions, or runtime QA.

## Agent Contract

- Read `DEPLOYMENT.md` before release, publish, installation, OTA, or deployed
  runtime QA.
- Identify the touched surface before running broad checks.
- For Chief Moa cross-surface work, verify by lane: browser voice, browser
  action/CDP, Android action/accessibility, gateway, workflow/docs, and
  verification/deploy.
- Prefer the narrowest command that proves the behavior, then broaden if the
  touched code crosses shared boundaries.
- Record the exact command, observed result, and blocker if a check fails.
- Do not turn a failing test into a changed product requirement without updating
  OpenSpec or a tracked task.

## Verification

- `cd gateway && npm run check`
- `cd browser_extension && npm run verify && npm run smoke`
- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`
