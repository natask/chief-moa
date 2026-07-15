# Production Coverage Program

## Goal

Every deployable surface must enforce at least 90% executable production
coverage for lines, branches, and functions. A repository-wide blended number
does not satisfy the goal. Tests, smoke harnesses, generated files, vendor code,
markup, and styles never contribute production coverage.

## Baseline Audit (2026-07-15)

| Surface | Lines | Branches | Functions/methods | Evidence status |
| --- | ---: | ---: | ---: | --- |
| Gateway | 81.03% | 76.93% | 85.33% | Node production-only run over `server.js` and `lib/**/*.js`; 813 tests passed and one skipped at the last whole-surface measurement. Extracted work-history, pet-collection, pet-sharing, pet-core, companion, profile, agent-run read/cancel, agent-worker, agent-run launch/follow-up, router-activation, and browser-agent-loop handlers plus the event substrate, companion catalog, release registry, proactive-turn policy, worker-pull state machine, worker runtime, JSON and PostgreSQL work graphs, video notes, account providers, agent profile, account connections, remote-mode policy, Brain, memory matcher, transcript-sidecar composition, and Exa search fallback each have permanent focused coverage above 90%. |
| Android | 17.94% | 21.80% | 23.51% | Exact JaCoCo ratchet passes with 144 JVM tests. Extracted agent-run and context-control state modules each have permanent focused coverage above 90%; generated Android classes remain the only exclusions. |
| Browser extension | 17.85% | 7.71% | 8.29% | Exact 25-file runtime classifier; 12 V8-executed files and conservative zero-count Istanbul metadata for 13 unloaded files. Extracted browser-turn and agent-loop policy modules have permanent focused gates above 90%. |
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
- Gateway: the complete production-only run passed 666 tests with one skip, but
  no isolated preview, backup/restore evidence, or state-compatibility rollout
  was established. The branch was therefore not pushed through the
  production-triggering `push-master.sh` path.
- Website: the hard 90% coverage gate passes, but Cloudflare preview credentials
  are unavailable, so no isolated Pages preview or active promotion occurred.

These ignored local artifacts are QA/release inputs, not evidence of an active
promotion. Windows WinUI, Android, browser extension, gateway, and Apple remain
below their whole-surface acceptance gates, so repository-wide promotion is
blocked even though the Windows core, LiveKit worker, and website gates pass.
