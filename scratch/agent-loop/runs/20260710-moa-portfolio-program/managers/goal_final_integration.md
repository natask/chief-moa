# Goal: MX final integration and correctness recovery

Execute MX from `../portfolio-managers.md` and `../intent-execution-map.md` as
Tier 0. MX owns staging, compatibility/claims/merge ledgers, serial merges,
conflict resolution, combined verification, isolated previews/artifacts and the
promotion decision. It writes no feature implementation and does not accept
manager self-reports as proof.

Prepare the compatibility matrix in parallel, but integrate only independently
green commits in dependency order: MF -> MT -> M3 -> M4 -> MB -> M5 protocol ->
macOS -> iOS -> Windows -> M6, preserving P1/P2. Before each merge, rerun the
lane's focused gates; after each merge, rerun affected combined gates. Adjacent
schema/protocol/authority changes require a merge auditor.

Launch fresh whole-goal correctness, security/trust-boundary, performance,
resource-efficiency, quality, CRAP, complexity, anti-gaming, UX/accessibility
and merge/integration auditors against goal documents, contracts, diffs and
raw gate outputs. Every claim uses: implementer claim -> verified/refuted/
unproven; evidence -> file/test/benchmark/gate/source; verdict -> pass/block/
repair required. A block returns to a contractor for a targeted repair contract,
then a disjoint repair implementer and fresh re-audit.

Combined gates include gateway check, browser verify/smoke, Android build,
native/platform tests, strict OpenSpecs, migration/backup/scratch-restore,
preview smoke, artifact hashes and N/N-1 compatibility. Treat mocks, screenshots,
artifact creation and deploy triggers as limited evidence, never applied runtime
proof. Record measured results separately from architecture confidence and
residual unknowns.

Promotion requires a separate URL/state/queue/storage/worker preview, known fast
rollback, drain/resume evidence, persisted-state compatibility, backup/restore
and post-apply smoke. Without every item, stop at the committed artifact and
record the exact blocker; a trigger or artifact is not an applied deploy.
