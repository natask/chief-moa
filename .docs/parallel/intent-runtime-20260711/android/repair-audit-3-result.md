# Android repair audit 3 result

Status: **PASS — ready for independent re-audit.**

The final-audit blockers in `repair-audit-3.md` are implemented inside the
Android lane. No commit, install, release packaging, preview, or deployment was
performed.

## Blocker evidence

1. **Draft execution is closed until canonical SEND.** A successful draft
   commit enqueue is the only place that opens execution admission
   (`MoaStreamingVoiceSessionController.java:973`, `:1020`, `:1042`). Raw
   pre-SEND execution events fail closed before dispatch
   (`MoaStreamingVoiceSessionController.java:1822`, `:1838`), and every typed
   transcript/assistant/audio/progress callback independently passes the same
   gate (`MoaStreamingVoiceSessionController.java:1869`, `:2231`). The failure
   cause is explicitly terminal (`MoaVoiceDraftFailurePolicy.java:15`, `:45`).
   Production-controller regression coverage begins at
   `MoaStreamingVoiceSessionControllerTest.java:19`.

2. **A resumed authoritative draft can SEND with zero new PCM.** Zero-audio
   cancellation is now legacy-only (`MoaStreamingVoiceSessionController.java:991`);
   draft mode continues to exact `sendDraftCommit` regardless of new local PCM
   (`MoaStreamingVoiceSessionController.java:1002`, `:1020`). A fresh controller
   created from a persisted pointer is tested both release-after-ready and
   release-before-ready with no emitted PCM at
   `MoaStreamingVoiceSessionControllerTest.java:52`.

3. **Lifecycle retirement covers sockets, capture, timers, playback, and UI
   callbacks.** Every session gets a new epoch
   (`MoaStreamingVoiceSessionController.java:520`, `:541`); retirement advances
   it and clears all event-scoped authority
   (`MoaStreamingVoiceSessionController.java:1276`). All recurring timers close
   over that epoch (`MoaStreamingVoiceSessionController.java:1284`, `:1298`,
   `:1312`, `:1323`), while active and terminal UI callbacks have separate epoch
   gates (`MoaStreamingVoiceSessionController.java:1912`, `:1926`). Draft error
   handling advances the Overlay generation before destroying the controller
   (`OverlayService.java:3712`, `:3715`).

4. **Terminal admission is exact and single-use, not a sticky boolean.** The raw
   receipt must first pass exact authority/revision parsing
   (`MoaVoiceDraftSessionState.java:276`). The controller records the exact typed
   event values in a `DraftTerminalAdmission`
   (`MoaStreamingVoiceSessionController.java:1800`, `:1940`), invalidates it on
   the next raw event, and consumes it on the first typed terminal attempt while
   matching turn, status, transcription, TTS, and language
   (`MoaStreamingVoiceSessionController.java:2340`). Exact mismatch, single-use,
   and later-event rejection are tested at
   `MoaStreamingVoiceSessionControllerTest.java:175` and `:201`.

5. **Synchronous effects are followed by epoch rechecks.** Socket construction,
   connect, session-start enqueue, buffered-audio enqueue, capture start, draft
   control enqueue, and SEND enqueue all terminate through the expected epoch
   and recheck before later mutation/callback
   (`MoaStreamingVoiceSessionController.java:520`, `:581`, `:592`, `:811`,
   `:881`, `:928`, `:965`, `:1020`, `:1042`, `:1589`, `:1616`, `:1647`). Synchronous ACK,
   synchronous capture failure, and callbacks already queued before failure are
   exercised at `MoaStreamingVoiceSessionControllerTest.java:144`, `:160`, and
   `:327`.

6. **Draft `session_start` is exact and alias-free.** The builder validates the
   strict context action and removes the legacy `conversation_id` before any
   serialization (`MoaVoiceGatewaySocket.java:202`, `:215`, `:230`). The exact
   key-set regression is at `MoaGatewayOnboardingTest.java:87`.

7. **Draft branch authority is parsed from raw exact strings.** The draft-only
   parser never calls `optString`, never trims/coerces, never falls back to an
   alias, and
   applies the bounded authority-token grammar
   (`MoaGatewayClient.java:126`, `:697`; `MoaVoiceDraftPointer.java:10`, `:88`).
   The draft admission path uses that parser before storing/opening anything
   (`OverlayService.java:3135`). Numeric, whitespace-padded, malformed, aliased,
   and missing authority regressions are at `MoaGatewayOnboardingTest.java:145`.

8. **`/health` is bounded by bytes and total elapsed time.** Defaults are 64 KiB
   and 6.5 seconds (`MoaGatewayClient.java:25`). The bounded GET constrains the
   initial connect/read timeout, arms an independent total deadline, rejects an
   oversized declared body, dynamically clamps each later read, and counts
   streamed bytes (`MoaGatewayClient.java:376`, `:398`, `:414`, `:658`). Oversize
   and drip-feed regressions are at `MoaGatewayClientTest.java:75` and `:88`.

## Production-consumed seams and late-callback proof

The fake ports are **not test-only policy doubles**. `Scheduler`, `CapturePort`,
and `SocketPort` are the interfaces used by the production controller
(`MoaStreamingVoiceSessionController.java:78`, `:88`, `:112`). The normal app
constructor installs Android Handler, real `MoaAudioCaptureController`, and real
`MoaVoiceGatewaySocket` adapters (`MoaStreamingVoiceSessionController.java:160`,
`:193`, `:248`, `:414`). The package-private constructor injects alternate
implementations into those same production effect sites
(`MoaStreamingVoiceSessionController.java:429`). Tests implement those exact
ports (`MoaStreamingVoiceSessionControllerTest.java:482`, `:560`, `:635`).

`assertLateCallbacksInert` injects late open, ready, transcript, assistant text,
assistant audio, progress, terminal, gateway-error, socket-failure, socket-close,
capture-start, PCM, capture-stop, capture-error, and every delayed timer callback
after teardown. It asserts no callback effect, no socket send/control/close/
destroy effect, and no capture start/stop effect
(`MoaStreamingVoiceSessionControllerTest.java:451`). It is run after:

- hostile pre-SEND failure (`:19`);
- ready timeout, control timeout, and ACK-wins retirement (`:85`, `:113`, `:130`);
- synchronous ACK and synchronous capture failure (`:144`, `:160`);
- invalid and valid terminal receipts plus exact-event mismatch (`:175`, `:201`);
- session-start enqueue failure, control enqueue failure, and socket close (`:252`);
- SEND enqueue failure (`:285`);
- local cancel, remote discard ACK, and explicit destroy (`:301`); and
- a terminal failure with application callbacks already queued (`:327`).

The socket fake counts every session start, audio frame, canonical/draft commit,
cancel, control, close, and destroy (`MoaStreamingVoiceSessionControllerTest.java:653`,
`:821`), so these regressions verify production effects rather than policy-only
state.

## Verification

- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest --rerun-tasks`
  — **PASS**, 104 tests, 0 failures, 0 errors, 0 skipped across 15 suites.
- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`
  — **PASS**.
- `git diff --check` — **PASS**.
- `git diff --no-index --check /dev/null <each untracked Android/lane-note file>`
  — **PASS**; this closes the normal `git diff --check` blind spot for untracked
  files.
- Worktree scope audit — **PASS**; changes remain under `android_app/**` and this
  Android lane's durable notes.

## Residual integration debt

- JVM tests deterministically cover the production controller through its real
  effect interfaces, but a physical Android phone is still required to validate
  actual `AudioRecord` ownership/pre-roll, permission transitions, gesture
  `ACTION_CANCEL`, process death/restart, Handler/Looper ordering, speaker drain,
  and OkHttp callback timing.
- A matching gateway implementation and isolated gateway preview are required
  for a real WS `voice_drafts_v1` create/park/restart/resume/SEND round trip and
  to confirm deployed receipt/revision compatibility. That service is outside
  this Android-only repair lane.
- The `/health` deadline is proven against a local JVM socket server. Its
  cross-thread `HttpURLConnection.disconnect()` behavior still needs the
  real-device/network smoke pass.
- No preview, rollback, backup/restore, recording-drain, install, or promotion
  evidence was created here. Active promotion therefore remains outside this
  repair result and subject to the repository deployment safety gate.
