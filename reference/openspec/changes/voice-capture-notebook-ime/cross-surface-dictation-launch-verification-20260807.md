# Cross-Surface Dictation Launch Verification — 2026-08-07

## Candidate

- Source candidate: `56f3a09fd740cc707e42c317ca6dbdee8fe60674` on
  `master` before this evidence-only update.
- This pass verified the existing provider-neutral gateway contract, Android
  voice-draft controls, browser dictation and recovery paths, and native Mac
  literal dictation as one launch candidate.
- No live service, installed extension, or installed app was changed during
  this pass.

## Reconciled implementation

- Android exposes capability-gated `Cancel` and `Pause`/`Resume` controls beside
  the orb. Pause stops local microphone capture before sending the exact draft
  id and revision; resume restarts capture only after a newer authoritative
  `voice_draft_state` for the same draft.
- The gateway keeps pause, resume, park, and discard inert until explicit send,
  and preserves draft audio ordering across restart.
- The browser exposes the same bounded draft controls, retains a failed stopped
  recording byte-for-byte across extension restart, and retries only after an
  explicit user action.
- Native Mac keeps literal dictation separate from assistant voice and exposes
  explicit capture, commit, cancel, and copy states.

## Automated evidence

- Android: `ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew lintDebug
  assembleDebug testDebugUnitTest` passed.
- Gateway: `npm run check` passed, including the full quality and coverage gate.
- Browser: `npm run verify && npm run smoke && npm run smoke:sidepanel` passed;
  281 unit tests passed, the real headless extension smoke passed, and the
  side-panel restart/recovery smoke passed.
- Native Mac: `swift test && swift build --product Ag` passed with 92 tests.
- OpenSpec: strict validation passed for `define-android-core-product-map`,
  `voice-capture-draft-controls`, and `voice-capture-notebook-ime`.
- Repository source-size policy passed through the Android and browser gates.

## Candidate artifacts

- Android debug APK:
  `android_app/app/build/outputs/apk/debug/app-debug.apk`, 4,396,292 bytes,
  SHA-256 `182c768b0a76a1d2c9f7bc05c354b493037566c9f291674222a8feaeec1ce32d`.
- Browser extension package: `browser_extension/dist/Ag-0.1.147.zip`, 557,129
  bytes, SHA-256
  `edbaba19f6c02504d5d7b8ec8130e84a58913f222b0c346bff243f9e3c0a11f2`.
- Ad-hoc-signed Mac QA archive:
  `apple_surfaces/dist/Ag-0.1.0-1-arm64.zip`, 693,823 bytes, SHA-256
  `b92ca4655ef3ec4848af2c0498be4154a8e99730df1eee271af0ee092729f441`.

## Live-state evidence and remaining launch gaps

- `https://api.agee.app/health` reported healthy and drain-safe, advertised the
  exact `voice_drafts_v1` contract, and reported no active capture. Its gateway
  build was `c9c65689c43389ab879418330b48da559237ef68`, while the active Android OTA
  record already identified source candidate
  `56f3a09fd740cc707e42c317ca6dbdee8fe60674` with rollback available.
- Android still needs physical-device proof that Pause releases the microphone,
  Resume appends to the same draft, Send preserves the ordered capture, IME
  insertion works in two ordinary apps, password fields refuse capture, and
  English/Amharic/mixed dictation behaves correctly.
- Browser still needs loaded-extension QA in the owner's real browser profile,
  including summon-after-removal, cross-tab ownership, clipboard output, and
  restart recovery against the production gateway.
- Native Mac still needs real microphone-permission and clipboard QA plus
  Developer ID signing and notarization; the archive here is QA-only.
- The production gateway is healthy and already serves the required draft
  contract, but it is not built from the current master candidate.
- Windows literal dictation remains missing.

