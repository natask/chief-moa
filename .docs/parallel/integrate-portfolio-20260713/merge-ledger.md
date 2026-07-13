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

| # | Branch | Tip | Result | Conflicts |
|---|--------|-----|--------|-----------|
| 1 | agent/intent-runtime-20260711-v2 | 05e1e80 | pending | |
| 2 | agent/surface-product-final-repair | ba13283 | pending | |
| 3 | agent/deploy-evidence-final-repair | 2cd2361 | pending | |
| 4 | agent/runtime-authority-final-repair | 98e71da | pending | |
| 5 | agent/macos-clicky-surface-20260711 | 69a041a | pending | |

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
