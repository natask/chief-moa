# Merge Ledger — integrate/portfolio-20260713

Tier-0 serial integration of the 2026-07-11 portfolio program.

- Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/integrate-portfolio-20260713`
- Branch: `integrate/portfolio-20260713`
- Base: `master` @ `691c244` (`fix(gateway): add voice diagnostics stage evidence`)
- Started: 2026-07-13

## Safety facts

- `.github/workflows/deploy-vps.yml` triggers only on push to `master` (paths: gateway/**, scripts/vps/**, compose files, the wf itself). Pushing `integrate/portfolio-20260713` triggers **no** deploy workflow. Push of the integration branch is safe.
- No push to master, no merge into master, no restart/deploy. Deliverable is a verified branch only.

## Merge order & results

| # | Branch | Tip | Merge commit | Result | Conflicts |
|---|--------|-----|--------------|--------|-----------|
| 1 | agent/intent-runtime-20260711-v2 | 05e1e80 | b4fe4cb | clean | none (247 files, +25334/-438) |
| 2 | agent/surface-product-final-repair | ba13283 | 7692416 | clean | none (0 gateway files) |
| 3 | agent/deploy-evidence-final-repair | 2cd2361 | c76c2e1 | clean | server.js auto-merged |
| 4 | agent/runtime-authority-final-repair | 98e71da | 35d04cd | clean | server.js auto-merged (disjoint region) |
| 5 | agent/macos-clicky-surface-20260711 | 69a041a | 8407e45 | resolved | 11 conflicts (see below) |

## Merge 5 conflict resolutions (agent/macos-clicky-surface-20260711)

The audit predicted 2 conflicts (Package.swift, AggieAppleSurface.swift). Actual: 11 (this branch also touches gateway protocol + openspec + browser).

1. `apple_surfaces/Package.swift` (add/add) — UNION: kept BOTH product targets `AggieSurfaceApp` (surface-product) and `MoaMac` (clicky) plus `MoaMacCore` lib + `MoaMacCoreTests`.
2. `apple_surfaces/Sources/AggieAppleSurface/AggieAppleSurface.swift` (add/add) — took OURS. Rationale: ours is the strict superset — typed enums (`SurfaceKind`/`ActionKind`/`ApprovalClass`/`ReceiptOutcome`), `EffectJournal` + `AtomicFileEffectJournal` crash-safety, `JSONValue` unsafe-number guard, credential scan uses `contains` (broader) vs theirs `hasSuffix`. Verified MoaMac/main.swift + MoaMacCore use ZERO AggieAppleSurface types (fully self-contained), and AggieSurfaceApp is a static SwiftUI demo shell needing only compilation — so both product targets compile against ours. Theirs' unique `ui.*` action kinds + string-set surface/action validation are not exercised by any runtime path; ours rejects unknown kinds via typed decode (equivalent-or-stricter).
3. `apple_surfaces/Tests/AggieAppleSurfaceTests/AggieAppleSurfaceTests.swift` (add/add) — took OURS (matches ours' typed-enum API + journal/restart/exclusive-claim/unsafe-number tests; superset of theirs).
4. `gateway/lib/aggie-surface-protocol.js` (add/add, 2 hunks) — took OURS' stricter guards (`isExecutableAuthorityKey` tokenized detection with benign exceptions + `EXECUTABLE_KEY_ROOTS` superset of theirs' `EXECUTABLE_KEYS`; `normalizeAuthorityKey`).
5. `gateway/test/aggie-surface-protocol.test.js` (add/add) — took OURS (superset test loop).
6. `gateway/package.json` (content) — UNION of npm scripts (kept `test:companion-package` + proactive smoke scripts).
7. `browser_extension/package.json` (content) — UNION (kept `smoke:proactive`, `test:proactive`, and merged `verify` to run both aggie-protocol-adapter test AND verify-extension).
8. `ARCHITECTURE.md` (content) — UNION: merged the Apple surface seam section (AggieSurfaceApp demo shell boundary) with theirs' MoaMac product flow/detail; dropped duplicate intro.
9. `reference/openspec/.../apple-native-aggie-surface/spec.md` (add/add) — took OURS (describes effect journal + restart recovery + closed enums, matching the kept implementation; theirs' "no disk" claim contradicts AtomicFileEffectJournal).
10. `reference/openspec/.../define-apple-native-aggie-surface/tasks.md` (add/add) — took OURS (Product shell + recovery + deferred platform work; matches integrated state).
11. `apple_surfaces/.gitignore` (add/add) — UNION (added `dist/`).

## Explicitly NOT merged (per audit)

- codex/preview-control-foundation, codex/telemetry-readback-final — duplicate M4/MT in gateway/lib/work-history.js, semantic-telemetry.js, event-substrate.js. **OPEN DECISION**: which implementation wins. Not merged.
- codex/dev-kernel-staging, codex/persistent-dev-worker — not in scope.
- reduction-* — docs-only research.
- entire/*, backup* — excluded.

## Known residual gap (recorded, not attempted)

- S6: gateway wiring of canonical intent runtime into HTTP/WS routes contracted but never built.
- signing/notarization/device tests/Postgres-live gates recorded SKIP/BLOCK by original program.

## Verification gate results (run in worktree, node v25.2.1, real npm not the pnpm alias)

- `gateway`: `npm install` (212 pkgs) + `npm run check` → **273 tests, 272 pass, 0 fail, 1 skipped**. Includes merged aggie-surface-protocol, proactive-turn, macos-proactive, runtime-authority, deployment-evidence (projection rebuild, idempotency, crash-after-effect) suites. PASS.
- `browser_extension`: `npm run verify` → aggie N/N-1 adapter pass + 7 sampler tests pass + proactive helper checks + extension verification passed. `npm run smoke` → **PASS** (REAL extension, headless Chrome for Testing; service worker loaded, cross-tab ownership transfer, type+click executed, no window/focus taken). PASS.
- `android_app`: `ANDROID_HOME=~/Library/Android/sdk ./gradlew assembleDebug` → **BUILD SUCCESSFUL**. PASS.
- `apple_surfaces` (not in AGENTS.md defaults, run because merge 5 made a nontrivial Swift decision): `swift build` → both product targets (AggieSurfaceApp + MoaMac) + MoaMacCore link. `swift test` → **24 tests pass** (ours' AggieAppleSurfaceTests incl. digest assertion + theirs' MoaMacCoreTests coexist). Validates the merge-5 resolution end to end. PASS.
- OpenSpec strict validation: **SKIPPED** — openspec CLI not installed and no `reference/openspec` project config in this checkout (per AGENTS.md, note skipped).

No genuine integration breakage was found; no post-merge fix commits were needed beyond the conflict resolutions.

## Open decisions (recorded, NOT resolved here — need a human design call)

- **codex/preview-control-foundation** and **codex/telemetry-readback-final** were NOT merged. They duplicate M4/MT functionality in `gateway/lib/work-history.js`, `gateway/lib/semantic-telemetry.js`, `gateway/lib/event-substrate.js`. A design decision is needed on which implementation (the intent-runtime superset's vs the codex telemetry branches') wins before either is integrated. Merging both would collide semantically.

## Release consolidation decision — 2026-07-13

- The integrated intent-runtime M4/MT implementation is the accepted line. The
  duplicate `codex/preview-control-foundation` and
  `codex/telemetry-readback-final` branches remain preserved but are not merged.
- The repository-approved `master` -> verified `vps-deploy` -> droplet timer
  promotion policy remains authoritative. The M4 deployment records are product
  evidence and APIs; they do not replace or disable that active VPS mechanism.
- The S6 canonical-intent HTTP/WebSocket wiring remains explicitly incomplete.
  Shipping the bounded domain modules does not claim that capability is live.

## Known residual gap (recorded, not attempted — per program audit)

- **S6**: gateway wiring of the canonical intent runtime into HTTP/WS routes was contracted but never built. The runtime domain modules are present (from merge 1) but not wired into live request/socket handlers.
- Signing / notarization / device tests / Postgres-live gates were all recorded **SKIP/BLOCK** by the original program. The Apple surfaces are unsigned compilation+package evidence only; not TCC-tested, not a production notarization artifact.

## Promotion readiness

- Deliverable is the verified integration branch `integrate/portfolio-20260713`. This task does NOT promote.
- Pushing this branch triggers **no** deploy workflow (`deploy-vps.yml` is master-only). Safe to push.
- Branch is promotion-*ready pending the active-promotion gate* (preview URL + smoke, rollback path, no interrupted user process, state compatibility, backup/restore for persisted gateway state) — that gate is a separate, later step and is NOT satisfied by this integration alone.

## Log

- Setup complete; worktree + ledger created.
- Merges 1-4 clean (server.js auto-merged textually across 3+4). Merge 5 resolved 11 conflicts.
- Full verification gate green (gateway/browser/android + bonus apple swift). OpenSpec skipped.
