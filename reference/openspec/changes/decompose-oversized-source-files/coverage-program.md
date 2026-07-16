# Production Coverage Program

## Goal

Every deployable surface must enforce at least 90% executable production
coverage for lines, branches, and functions. A repository-wide blended number
does not satisfy the goal. Tests, smoke harnesses, generated files, vendor code,
markup, and styles never contribute production coverage.

## Baseline Audit (2026-07-15)

| Surface | Lines | Branches | Functions/methods | Evidence status |
| --- | ---: | ---: | ---: | --- |
| Gateway | 85.16% | 81.15% | 87.51% | Node production-only run over `server.js` and `lib/**/*.js`; 1014 tests passed and one skipped at the last whole-surface measurement. Extracted gateway-health projection, voice control/diagnosis/LiveKit routing, audio/video-note routing, broker message/research/report, thread switching, session/thread/history/context reads, supervisor-status and harness-discovery, presentation-evaluation, Android OTA, account-connection, work-history, work-graph, product-event/project, device/tool, browser-turn/evidence, legacy and agent-loop browser-task, pet-collection, pet-sharing, pet-core, companion, profile, agent-run read/cancel, agent-worker, agent-run launch/follow-up, router-activation, browser-agent-loop policy, self-extension, UI-spec, and billing-runtime handlers plus the durable project store, runtime authority, the UI-spec and self-extension artifact stores, full work-history state machine, profile options, research workflow, preview adapter, audio notes, voice chunking and routing, event substrate, companion catalog, release registry, proactive-turn policy, worker-pull state machine, worker runtime, JSON and PostgreSQL work graphs, video notes, account providers, agent profile, account connections, remote-mode policy, Brain, memory matcher, transcript-sidecar composition, and Exa search fallback each have permanent focused coverage above 90%. |
| Android | 17.94% | 21.80% | 23.51% | Exact JaCoCo ratchet passes with 144 JVM tests. Extracted agent-run and context-control state modules each have permanent focused coverage above 90%; generated Android classes remain the only exclusions. |
| Browser extension | 55.39% | 36.59% | 31.68% | Exact 33-file runtime classifier; 31 V8-executed files and conservative zero-count Istanbul metadata for the two oversized unloaded orchestration files. All 49 unit tests and the real headless-Chromium extension smoke pass. Twenty-one runtime modules have permanent focused gates above 90%; content now delegates audio/video note capture state, voice-conflict guards, context failures, upload receipts, and video auto-stop coordination to a focused controller at 100% lines, 93.05% branches, and 100% functions. |
| LiveKit worker | 99.07% | 90.40% | 92.00% | Hard production-only gate passes with all six compiled runtime modules loaded and 19 tests covering worker, STT, LLM, TTS, auth, streaming, and failure paths. |
| Website | 96.09% | 90.40% | 97.47% | Hard `c8 --all` gate covers all seven Pages handlers and four extracted public runtime modules with 42 passing tests; owned HTML contains no inline executable JavaScript. |
| Apple surfaces | 84.60% | unavailable | 85.42% | Protocol drift is repaired, 45 tests pass, and both instrumented apps build and execute inert bootstrap smokes. The exact classifier combines test and executable profiles; LLVM regions are 78.67%, while this Swift toolchain emits no branch counters, so the hard 90% gate fails closed. Native TCC-dependent shell paths are now measured consistently instead of inheriting a transient trusted test-runner result. |
| Windows portable core | 98.56% | 92.07% | 98.15% | Hard Rust gate passes with 27 tests. This does not cover the separate WinUI C# executable. |
| Windows WinUI shell | unmeasured | unmeasured | unmeasured | Native C#/WinUI instrumentation requires a Windows runner and remains a separate acceptance check. |

These are starting measurements, not release claims. A percentage remains
invalid if an eligible production file is absent from coverage metadata.

## Exact Scope Rules

Each surface coverage command must enumerate tracked owned files and classify
each exactly once:

1. executable production;
2. UI markup/style;
3. operational tooling;
4. migration/schema;
5. generated/vendor;
6. test;
7. fixture.

The coverage runner must fail on an unclassified or multiply classified file.
Executable entrypoints count even when they are difficult to test. A tiny
bootstrap may be separated from testable application logic, but it may not be
silently excluded. Browser and website coverage must additionally fail when an
eligible script is missing from the merged V8/Istanbul metadata.

## Implementation Tickets

Each ticket has one observable acceptance check and is committed separately.

1. **Coverage scope and reporting**
   - Add exact per-surface classification and non-vacuous coverage reports.
   - Acceptance: every tracked owned source file is classified exactly once and
     every eligible executable file appears in its surface report.
2. **LiveKit worker gate**
   - Extract import-safe, injected worker/plugin seams and test their success,
     rejection, streaming, authentication, and cleanup paths.
   - Acceptance: build and tests pass with a hard 90% line/branch/function gate.
3. **Windows authority-core gate**
   - Add reproducible Rust coverage tooling and close report-driven gaps.
   - Acceptance: Rust lines/branches/functions are each at least 90%; WinUI gets
     a separate Windows-runner report rather than inheriting the Rust number.
4. **Gateway gate**
   - Cover bounded domain modules first, then extract remaining `server.js`
     domains so route behavior can be exercised through injected handlers.
   - Acceptance: all gateway executable production reaches 90% for all three
     metrics and `npm run check` enforces it.
5. **Android gate**
   - Add JaCoCo reporting, close pure-policy gaps, decompose `OverlayService`,
     and merge JVM plus emulator/device evidence for Android-only behavior.
   - Acceptance: merged LINE/BRANCH/METHOD totals are each at least 90% and the
     Gradle verification task enforces them.
6. **Browser-extension gate**
   - Make all existing tests attributable, split `background.js` and
     `content.js`, and merge Node with Chromium precise coverage for every
     extension execution target.
   - Acceptance: all 23 owned runtime scripts appear in the merged report and
     lines/branches/functions are each at least 90%.
7. **Website gate**
   - Extract inline JavaScript, directly test Pages handlers, and test browser
     behavior through DOM/media/network adapters.
   - Acceptance: functions plus public runtime JavaScript each participate in a
     hard 90% line/branch/function gate.
8. **Apple gate**
   - Repair protocol type drift, move app behavior behind test-linked modules,
     and combine library/application profiles.
   - Acceptance: Swift lines/branches/functions are each at least 90% without
     omitting executable shell behavior.
9. **PR enforcement**
   - Publish per-surface summaries and changed-line ratchets in CI.
   - Acceptance: a below-threshold surface or missing eligible file fails its
     native verification job.

## Verification Order

Run the native tests first, then the production-only coverage gate, then the
surface build/smoke command. Coverage work does not authorize weakening,
deleting, or excluding meaningful failure-path and integration tests.

## Artifact And Promotion Record (2026-07-15)

- Browser extension: the real headless-Chrome smoke passed and the committed
  `0.1.40` runtime was packaged as `browser_extension/dist/A.G.-0.1.40.zip`.
  The already-loaded browser was not reloaded because interruption-free active
  browser state was not proven.
- Android: `assembleDebug` passed and the versioned OTA artifact
  `ai.moa.assistant-1784106283` was created under
  `gateway/data/android-ota/releases/`. It was not synced or installed because
  an interruption-free phone session was not proven and the VPS host/token are
  unavailable in this checkout.
- Apple: the ad-hoc signed QA bundle was created at
  `apple_surfaces/dist/MoaMac.app`; packaging did not launch it or request TCC
  permissions.
- Browser extension: version `0.1.45` was verified, smoke-tested in real
  headless Chromium, and packaged as
  `browser_extension/dist/A.G.-0.1.45.zip` (418,213 bytes). The dev-reload
  bridge received no poll during its bounded 40-second window, so reload of an
  already-loaded unpacked extension remains unverified; one manual reload at
  `chrome://extensions` is required to enable confirmation for later deploys.
- Browser extension: version `0.1.47` was verified with all 38 unit tests and
  the real headless-Chromium smoke, then packaged as
  `browser_extension/dist/A.G.-0.1.47.zip` (418,409 bytes). The bounded reload
  window again received no client poll, so active reload remains unverified and
  still requires one manual reload at `chrome://extensions`.
- Browser extension: version `0.1.49` was verified with all 42 unit tests and
  the real headless-Chromium smoke, then packaged as
  `browser_extension/dist/A.G.-0.1.49.zip` (419,441 bytes). The bounded reload
  window received no client poll, so active reload remains unverified and still
  requires one manual reload at `chrome://extensions`.
- Browser extension: version `0.1.50` was verified with all 43 unit tests and
  the real headless-Chromium smoke, then packaged as
  `browser_extension/dist/A.G.-0.1.50.zip` (420,106 bytes). The bounded reload
  window received no client poll, so active reload remains unverified and still
  requires one manual reload at `chrome://extensions`.
- Browser extension: version `0.1.51` was verified with all 43 unit tests and
  the real headless-Chromium smoke, then packaged as
  `browser_extension/dist/A.G.-0.1.51.zip` (418,934 bytes). The bounded reload
  window received no client poll, so active reload remains unverified and still
  requires one manual reload at `chrome://extensions`.
- Browser extension: version `0.1.52` was verified with all 44 unit tests, the
  exact production coverage ratchet, and the real headless-Chromium smoke, then
  packaged as `browser_extension/dist/A.G.-0.1.52.zip` (419,453 bytes; SHA-256
  `b42d08735741e8843854b97fc76d2aba562b1acb7eb90f034e0493012f11121e`). The
  bounded 40-second reload window received no client poll, so active reload
  remains unverified and still requires one manual reload at
  `chrome://extensions`.
- Browser extension: version `0.1.53` was verified with all 45 unit tests, the
  exact production coverage ratchet, and the real headless-Chromium smoke, then
  packaged as `browser_extension/dist/A.G.-0.1.53.zip` (420,178 bytes). The
  deployed release-worktree ZIP had SHA-256
  `a433ecf3c010b8a68a4db139734a1c8ac530255614e6d9009e9c1f6cd7dffe13`; the
  retained same-source package has SHA-256
  `db41f87c18b38909fc90624166cfd0d84a86cc8d30471100794bfdbfcee72145` because
  ZIP metadata is checkout-dependent. Active reload was confirmed: the loaded
  unpacked extension observed the version bump and polled again after reloading.
- Browser extension: version `0.1.54` was verified with all 46 unit tests, the
  exact production coverage ratchet, and the real headless-Chromium smoke, then
  retained as `browser_extension/dist/A.G.-0.1.54.zip` (420,367 bytes; SHA-256
  `dd1ea7bde11a402799dcd14eb193f2048fc26500642802f1fbdf75615423f13b`). Active
  reload was confirmed when the loaded unpacked extension observed the version
  bump and polled again after reloading.
- Browser extension: collision-safe version `0.1.56` was verified with all 47
  unit tests, the exact production coverage ratchet, and the real
  headless-Chromium smoke, then retained as
  `browser_extension/dist/A.G.-0.1.56.zip` (420,930 bytes; SHA-256
  `6d898a6a4d050ab5eeb3e9736fdf2eb83107078319086a3a43fe954090748900`). Active
  reload was confirmed when the loaded unpacked extension observed the version
  bump and polled again after reloading.
- Browser extension: collision-safe version `0.1.58` was verified with all 48
  unit tests, the exact production coverage ratchet, and the real
  headless-Chromium smoke, then retained as
  `browser_extension/dist/A.G.-0.1.58.zip` (421,897 bytes; SHA-256
  `7c627bc535379969337703922a04f57f4f30414554f6b7164bf1557c4ba329bc`). Active
  reload was confirmed when the loaded unpacked extension observed the version
  bump and polled again after reloading.
- Browser extension: collision-safe version `0.1.59` was verified with all 49
  unit tests, the exact production coverage ratchet, and the real
  headless-Chromium smoke, then retained as
  `browser_extension/dist/A.G.-0.1.59.zip` (422,440 bytes; SHA-256
  `50267b25543f5f64aae12b91e87bd11923fcff531172df57bee4862773f7b7b5`). Active
  reload was confirmed when the loaded unpacked extension observed the version
  bump and polled again after reloading.
- Gateway: the complete production-only run passed 1014 tests with one skip, but
  no isolated preview, backup/restore evidence, or state-compatibility rollout
  was established. The branch was therefore not pushed through the
  production-triggering `push-master.sh` path.
- Website: the hard 90% coverage gate passes, but Cloudflare preview credentials
  are unavailable, so no isolated Pages preview or active promotion occurred.

These ignored local artifacts are QA/release inputs, not evidence of an active
promotion. Windows WinUI, Android, browser extension, gateway, and Apple remain
below their whole-surface acceptance gates, so repository-wide promotion is
blocked even though the Windows core, LiveKit worker, and website gates pass.
