# Tasks

## 1. Establish Guardrails

- [x] 1.1 Inventory tracked production source files above 2,000 lines.
- [x] 1.2 Add a repository source-size policy with explicit debt ceilings.
- [x] 1.3 Run the policy from the gateway test suite.
- [x] 1.4 Critique the 10,000-line/2x-test proposal, retain both as ultimate
      constraints, and add a 60,000-line first milestone to prevent destructive
      metric chasing.
- [x] 1.5 Add a production-only 90% lines/branches/functions gate for the first
      extracted slice.
- [ ] 1.6 Extend the production-only coverage gate to every changed surface.
- [ ] 1.7 Classify every owned source file exactly once as executable, UI,
      operational tooling, migration/schema, generated/vendor, test, or fixture.
- [ ] 1.8 Add per-surface PR coverage reporting and changed-line ratchets.
- [x] 1.9 Record audited per-surface baselines, exact scope rules, staged
      implementation tickets, and non-vacuous acceptance checks in
      `coverage-program.md`.

## 2. Gateway Decomposition

- [x] 2.1 Extract and unit-test browser-evidence normalization.
- [x] 2.2 Extract browser-turn lifecycle and persistence with a focused 90%
      line/branch/function coverage gate; reduce `server.js` to 15,529 lines.
- [x] 2.3a Extract deterministic broker routing with a focused 90%
      line/branch/function coverage gate.
- [x] 2.3b Extract broker context-pack and launch handlers with a focused 90%
      line/branch/function coverage gate; reduce `server.js` to 14,983 lines.
- [ ] 2.3c Extract work-history handlers.
- [ ] 2.4 Extract companion, pet, and profile handlers.
- [ ] 2.5 Extract agent-run lifecycle, harnesses, and work graph handlers.
- [ ] 2.6 Split voice diagnosis, cascaded reasoning, and turn persistence.
- [ ] 2.7 Extract context, thread, and history assembly.
- [ ] 2.8 Extract device-client, browser-task, and tool-request stores.
- [ ] 2.9 Move provider adapters and HTTP routes behind bounded modules.
- [ ] 2.10 Reduce `server.js` below 2,000 lines and remove its debt exemption.
- [ ] 2.11 Split the durable voice-draft store into bounded state, persistence,
      authority, and recovery modules.

## 3. Other Oversized Surfaces

- [ ] 3.1 Split extension background orchestration below 2,000 lines.
- [ ] 3.2 Split extension content UI/voice/action responsibilities below 2,000 lines.
- [ ] 3.3 Split Android overlay lifecycle, UI, voice, and action coordination below 2,000 lines.
- [ ] 3.4 Split voice provider implementations into provider-specific modules.
- [ ] 3.5 Reduce the voice-session transport below 2,000 lines.
- [ ] 3.6 Split the pet-library page into bounded markup, style, and behavior files.
- [ ] 3.7 Reduce the work-history module below 2,000 lines.

## 4. Production Coverage Rollout

- [x] 4.1 Enforce at least 90% lines, branches, and functions for the Windows
      portable Rust core. Verified at 98.56% lines, 92.07% branches, and 98.15%
      functions with 27 passing tests.
- [ ] 4.2 Add a separate 90% line/branch/method report for the WinUI C# shell on
      a Windows runner.
- [x] 4.3 Add an exact browser-extension runtime classifier and non-vacuous
      production coverage ratchet that counts unloaded eligible files as zero.
      Baseline: 14.99% lines, 4.87% branches, and 6.73% functions.
- [ ] 4.4 Merge Node and Chromium target coverage and raise the browser hard
      gate to at least 90% lines, branches, and functions.
- [x] 4.5 Enforce at least 90% lines, branches, and functions for the LiveKit
      worker. Verified at 99.07% lines, 90.40% branches, and 92.00% functions
      with all 19 tests passing.
- [x] 4.6 Add a production-only Android JaCoCo report and exact non-regression
      gate. Baseline: 16.43% lines, 19.79% branches, and 21.49% methods with
      128 passing JVM tests.
- [ ] 4.7 Merge JVM and emulator/device evidence and raise the Android hard gate
      to at least 90% lines, branches, and methods.

## Verification

- `node scripts/source-size-policy.js`
- `cd gateway && npm run check`
- Surface-native verification for each later extraction.
