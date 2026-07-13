# Artifact and promotion status

This unit is a library/spec foundation and has no standalone deployable artifact
or preview. It is intentionally not wired into the running gateway.

Active promotion is blocked because there is no isolated telemetry Collector or
backend URL/state, no MF consent/deletion authority, no cross-surface adapter,
and no measured preview evidence. The repaired timeout quarantine was verified
only by deterministic local tests, not by a preview exporter. No active process,
data store, or deployment was changed. Rollback of the candidate is the single
branch commit before Tier 0 integration.

`npm ci` reported two high-severity dependency findings in the existing lockfile.
No forced/breaking dependency update was applied; this telemetry unit adds no
dependency. The dependency findings remain a repository risk for separate triage.
