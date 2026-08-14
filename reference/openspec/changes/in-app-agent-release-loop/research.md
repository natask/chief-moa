# Prior Art And Repository Audit

## External Evidence

| System | Relevant pattern | Chief Moa application |
| --- | --- | --- |
| [GitHub coding agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents) | Mobile/web prompts become durable asynchronous work with review and follow-up. | One named request and inspectable history per user objective; voice is not the only control. |
| [OpenAI Codex](https://openai.com/index/introducing-codex/) | Independent coding tasks run concurrently in isolated environments and return logs/tests for review. | Parallelize only disjoint graph nodes; retain exact result commits and evidence. |
| [Cursor background agents](https://docs.cursor.com/background-agent) | Signed-in users launch, monitor, follow up, and take over asynchronous runs. | Authenticated Work inbox and narrow development-request API; isolate internet-connected workers and credentials. |
| [Expo EAS Update](https://docs.expo.dev/eas-update/deployment/) | Preview/staging/production channels point to runtime-compatible immutable updates. | Feature, Trial, and Stable are immutable bundle assignments/pointers, not Git branches. |
| [Expo rollback](https://docs.expo.dev/eas-update/rollbacks/) | Broken updates may prevent users from reaching their own rollback UI. | Keep native rescue and signed cached recovery metadata below the trial/voice surface. |
| [Vercel promotion](https://vercel.com/docs/deployments/promoting-a-deployment) and [rollback](https://vercel.com/docs/instant-rollback) | Promote or roll back an existing immutable deployment without rebuilding. | Promote exact tested bytes; pointer movement is atomic, serialized, and auditable. |
| [GitHub deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments) and [history](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/view-deployment-history) | Checks, approvals, concurrency, deployment URLs, commits, logs, and history are first-class. | Promotion is a guarded transaction, not a UI label. Preserve actor, evidence, before/after heads, and rollback. |
| [Graphite stacked changes](https://graphite.com/docs/cli-quick-start) | Dependency-ordered changes remain independently reviewable and testable; legitimate conflicts stop automation. | Store dependency edges and rerun checks on the exact composed trial; do not hide semantic conflicts. |
| [GitHub Copilot conflict assistance](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github) | An agent can propose conflict resolution and tests, followed by human review. | AI proposes and verifies; user confirms ambiguous behavioral reconciliation. |
| [LaunchDarkly change history](https://launchdarkly.com/docs/home/releases/change-history) and [version restore](https://launchdarkly.com/docs/home/releases/version-restore) | Actor/time/environment/diff history is retained; restore creates a new version. | Rollback appends history and keeps user/device assignments distinct from global stable. |

The architecture derived from these sources is an inference: no single vendor
implements the complete Chief Moa flow.

## Chief Moa: Already Present

- The development planner requests 2–32 narrow tasks with dependencies, path
  claims, acceptance checks, memory estimates, parallel-safety, integration, and
  final QA.
- The coordinator respects dependencies, path overlap, configured worker count,
  and memory, then automatically dispatches later waves.
- Completed implementation/integration/QA can freeze an immutable candidate.
- Release control stores append-only bundles, stable/preview heads, assignments,
  install receipts, exact feedback, and candidate lineage.
- Android can browse/select an exact candidate, distinguish selection from
  installation, verify APK bytes/signer, and return to stable.
- `ce10359f` corrected historical fallback artifact projection.
- `67d2447b` contained broad enrolled-device access to high-authority routes.

## Chief Moa: Gaps

- Android has no development-request list/detail/plan client or Work cards.
- Ordinary voice/text task routing and the richer development planner are
  separate intake paths.
- Plan generation and execution are currently coupled in the development web
  surface; users cannot inspect and approve a plan first.
- Development records are not fully tenant/user/resource scoped, and completion
  evidence is not yet strongly bound to worker leases and independent review.
- Owner-only Better Auth and token-derived legacy identity do not provide full
  multi-user data isolation; device credentials need revocation.
- `Promote to trial` currently selects the existing preview head instead of
  composing/promoting the chosen feature.
- Lineage is metadata; no service performs source composition, conflict repair,
  rebuild, and exact publication.
- Trial/assignment history is stored but not projected as history or one-tap
  predecessor undo.
- Android downgrade rules make an older APK unsuitable as normal one-tap
  rollback; recovery must be forward-versioned.
- Promotion planning/publishing primitives exist, but no complete in-app
  proposal/approval/history flow connects them.

## Master Orch Reuse Boundary

The sibling Master Orch project demonstrates durable feedback -> crystallized
ticket -> run -> QA -> candidate -> review stages, version threads, isolated
runner state, and atomic current-release pointer changes. Chief Moa should reuse
those interaction concepts through contracts. It should not copy Master Orch's
automatic branch-per-run behavior because the repository operator contract
requires guarded, sequenced work on `master` and recorded shared-file ownership.

## Team Size Decision

Building this platform needs seven roles across two waves:

1. coordinator/specification and contract ownership;
2. account, tenant, device-scope, and storage isolation;
3. Android recovery and development UI;
4. feedback/intake-to-plan bridge;
5. worker, integration, and conflict repair;
6. release composition, history, undo, and promotion; and
7. independent verification and release operation.

Runtime task agents are not fixed at seven. The existing planner chooses task
count, and the scheduler chooses active concurrency from the dependency graph
and resource limits.
