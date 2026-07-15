# S3 Android Capture Controls Goal

## Goal

Implement a pure directional hold resolver and Android surface state needed for
release/send, left/pause, up/park, and down/discard. OS `ACTION_CANCEL` must
always discard/no-execute. Explicit new-root must fail closed rather than
silently fall back to default.

## Owned paths

- Android assistant source and unit tests only.

## Branch and worktree

- Branch: `agent/android-draft-controls-20260711`
- Worktree:
  `/Users/natnaelkahssay/projs/chief-moa-worktrees/android-draft-controls-20260711`

## Acceptance

- Direction classification is pure, dominant-axis, thresholded, and tested.
- Pre-hold movement preserves orb drag.
- A confirmed hold does not commit on `ACTION_CANCEL`.
- Release/send, pause, park, and discard use distinct callbacks/state.
- Legacy flag-off gestures remain compatible.
- New-thread failures do not continue on the default/current thread.

## Verification

`cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest assembleDebug`

## Verification notes

- `git diff --check -- android_app .docs/parallel/intent-runtime-20260711/android/goal.md` passed.
- `cd android_app && ANDROID_HOME="/Users/natnaelkahssay/Library/Android/sdk" ./gradlew lintDebug`
  failed in the sandbox before Gradle startup because the wrapper could not open
  `~/.gradle/wrapper/dists/gradle-8.10.2-bin/.../gradle-8.10.2-bin.zip.lck`
  (`Operation not permitted`).
- `cd android_app && GRADLE_USER_HOME="/private/tmp/chief-moa-gradle-home"
  ANDROID_HOME="/Users/natnaelkahssay/Library/Android/sdk" ./gradlew
  testDebugUnitTest assembleDebug` failed when the sandbox blocked wrapper
  download with `java.net.UnknownHostException: services.gradle.org`.

## Do not touch

- Gateway, browser, deployment files, credentials, active app/data, or unrelated
  Android actions/pet/settings behavior.
