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

## Log

- Setup complete; worktree + ledger created.
