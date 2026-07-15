# Production Coverage Program

## Goal

Every deployable surface must enforce at least 90% executable production
coverage for lines, branches, and functions. A repository-wide blended number
does not satisfy the goal. Tests, smoke harnesses, generated files, vendor code,
markup, and styles never contribute production coverage.

## Baseline Audit (2026-07-15)

| Surface | Lines | Branches | Functions/methods | Evidence status |
| --- | ---: | ---: | ---: | --- |
| Gateway | 72.28% | 68.75% | 76.76% | Node production-only run over `server.js` and `lib/**/*.js`; 525/527 tests passed, one skipped, and one work-history lease smoke expired while a duplicate coverage run was competing. |
| Android | 16.43% | 19.79% | 21.49% | Production-only JaCoCo report over 8,027 executable lines, 4,471 branches, and 1,089 methods; the exact baseline ratchet passes with 128 JVM tests and excludes generated Android classes only. |
| Browser extension | 16.65% | 6.57% | 7.86% | Exact 24-file runtime classifier; 11 V8-executed files and conservative zero-count Istanbul metadata for 13 unloaded files. The extracted browser-turn protocol has a permanent 100/95.90/100 focused gate. |
| LiveKit worker | 99.07% | 90.40% | 92.00% | Hard production-only gate passes with all six compiled runtime modules loaded and 19 tests covering worker, STT, LLM, TTS, auth, streaming, and failure paths. |
| Website | unmeasured | unmeasured | unmeasured | No test runner exists and about 2,315 executable JavaScript lines remain embedded in HTML. |
| Apple surfaces | blocked | blocked | blocked | `swift test --enable-code-coverage` is blocked by typed protocol drift; executable shells are not linked into the SwiftPM test product. |
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
