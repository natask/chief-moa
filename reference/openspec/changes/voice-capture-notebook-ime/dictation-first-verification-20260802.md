# Dictation-First Candidate Verification — 2026-08-02

## Candidate scope

- Android adds a real `InputMethodService` literal-dictation path with explicit
  review and insertion, sensitive-editor refusal, editor-session binding, and
  an `android-ime` source identity.
- Android voice-draft Cancel is left of the orb and Pause/Resume is right of the
  orb. The controls share the orb's vertical center and stay within the screen,
  leaving the user and assistant transcript lanes unobstructed.
- Native Mac adds a literal-dictation activity separate from assistant voice,
  uses the gateway transcription-only contract, and exposes exact transcript
  copy with an explicit clipboard receipt.
- Existing gateway and browser dictation paths were reverified without source
  changes.

## Automated evidence

- Android: `lintDebug assembleDebug testDebugUnitTest` passed, including 552
  unit tests and the left/right control geometry, sensitive-editor, IME source,
  and insertion-policy seams.
- Gateway: `pnpm install --frozen-lockfile` followed by `npm run check` passed.
- Browser extension: `npm run verify && npm run smoke` passed, including the
  real headless-Chrome smoke.
- Native Mac: `swift test && swift build --product Ag` passed with 80 tests.
- Contract and repository: strict OpenSpec validation and
  `node scripts/source-size-policy.js` passed.

## Promotion blockers and remaining acceptance

- Android still needs physical-phone IME QA in two ordinary apps, password
  refusal QA, English/Amharic/mixed-language QA, and confirmation that an OTA
  install will not interrupt an active phone session. Until then, the verified
  debug APK is a candidate artifact, not an active OTA promotion.
- Browser still needs loaded-extension cross-tab clipboard QA against the exact
  promoted gateway candidate. Automated extension verification is complete.
- Native Mac still needs real microphone/clipboard QA plus Developer ID signing
  and notarization. The repository can produce an ad-hoc signed QA archive, not
  a public macOS release.
- Windows literal dictation and the stored-audio-first capture/notebook
  lifecycle remain missing and are not represented as shipped.
