# Android Screenshot Authority Adapter Evidence

Candidate branch: `hygiene/android-screenshot-authority`

Scope is ticket 1 only. The Android accessibility adapter accepts a one-shot
explicit-consent request bound to an expected package, refuses unavailable,
unsupported, mismatched, stale, or password-bearing observations, maps Android's
secure-window screenshot failure to a no-bytes denial, revalidates the package
after capture, and emits only a locally held JPEG bounded to 1280 x 1280 and
420 KiB with capture time and SHA-256 metadata. No caller, networking, gateway,
IME, model, action, or deployment integration is present.

## Deterministic evidence

- `cd android_app && ANDROID_HOME="/Users/natnaelkahssay/Library/Android/sdk" ./gradlew test`
  passed.
- `cd android_app && ANDROID_HOME="/Users/natnaelkahssay/Library/Android/sdk" ./gradlew assembleDebug`
  passed.
- `cd android_app && ANDROID_HOME="/Users/natnaelkahssay/Library/Android/sdk" ./gradlew reportDebugUnitTestCoverage`
  passed.
- JaCoCo class counters for `MoaScreenshotPolicy`: line 30/30 (100%), branch
  40/42 (95.24%), method 7/7 (100%).
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
