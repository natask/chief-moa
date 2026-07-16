# Android Screenshot Authority Adapter Evidence

> Historical evidence for the isolated `4de52d15` candidate. The later Android
> integration connects it only to visible Ask; see
> `android-screen-dictation-integration-evidence.md`.

Candidate branch: `hygiene/android-screenshot-authority`

Scope is ticket 1 only. The Android accessibility adapter accepts a process-local
explicit-consent capability bound to an expected package and atomically consumes
it before the first authorization attempt. Sequential or concurrent replay cannot
authorize a second capture, even when the first attempt is denied. The adapter
refuses unavailable, unsupported, mismatched, stale, or password-bearing
observations, maps Android's secure-window screenshot failure to a no-bytes
denial, revalidates the package after capture, and emits only a locally held JPEG
bounded to 1280 x 1280 and 420 KiB with capture time and SHA-256 metadata. No
caller, networking, gateway, IME, model, action, or deployment integration is
present.

## Deterministic evidence

- `cd android_app && ANDROID_HOME="/Users/natnaelkahssay/Library/Android/sdk" ./gradlew test`
  passed.
- `cd android_app && ANDROID_HOME="/Users/natnaelkahssay/Library/Android/sdk" ./gradlew assembleDebug`
  passed.
- `cd android_app && ANDROID_HOME="/Users/natnaelkahssay/Library/Android/sdk" ./gradlew reportDebugUnitTestCoverage`
  passed.
- Replay regressions cover sequential reuse, denied-attempt reuse, and a
  synchronized 24-caller race that authorizes exactly one caller.
- JaCoCo class counters for `MoaScreenshotPolicy`: line 35/35 (100%), branch
  44/46 (95.65%), method 8/8 (100%).
- JaCoCo class counters for `MoaScreenshotCapture`: line 9/9 (100%), branch 6/6
  (100%), method 2/2 (100%).

## Not measured

- Physical Android allowed capture from the selected package.
- Accessibility permission denial and Android versions below API 30.
- A real `FLAG_SECURE` window returning
  `ERROR_TAKE_SCREENSHOT_SECURE_WINDOW` with no bytes.
- A password-bearing accessibility tree refusing capture before the platform
  screenshot call.
- App switch during the asynchronous capture producing a target-mismatch denial
  and releasing the screenshot buffer.

Ticket 1 remains unchecked until this physical-phone QA is recorded.
