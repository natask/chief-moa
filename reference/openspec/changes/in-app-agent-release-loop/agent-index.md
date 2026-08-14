# Agent, File, Branch, And Worktree Index

## Operating Rules

- Branch: `master` for every lane. No lane creates a branch.
- Worktree: `/Users/natnaelkahssay/projs/chief-moa`, shared by every lane.
- Every lane announces exact path ownership before editing and uses explicit
  path staging. Unrelated dirty files are preserved.
- Overlapping files run serially. A lane releases ownership after verification
  and its conventional commit.
- Integration uses the guarded local master flow. GitHub Actions are not release
  authority.
- No lane deploys. The release operator creates artifacts/previews and promotes
  only after all safety gates pass.

## Research And P0 Session Index

| Lane | Agent/task | Branch | Worktree | Owned paths | Status | Commit / exit criteria |
| --- | --- | --- | --- | --- | --- | --- |
| Lead/spec | `chief_moa_orchestration_lead` | `master` | shared current worktree | `reference/openspec/changes/in-app-agent-release-loop/**` | active | OpenSpec validates; docs commit only |
| Prior art | `prior_art` | `master` | shared current worktree | none, read-only | complete | Primary/official evidence matrix delivered |
| Mobile fallback/auth audit | `mobile_fallback` | `master` | shared current worktree | none, read-only | complete | Exact Android gaps and acceptance cases delivered |
| Orchestration audit | `orchestration_audit` | `master` | shared current worktree | none, read-only | complete | Chief Moa/Master Orch reuse boundary delivered |
| Release P0 | `release_plane` | `master` | shared current worktree | `release_control_plane/lib/http.mjs`; `release_control_plane/test/service.test.mjs` | complete | `ce10359f`; package tests 43/43 |
| Security P0 | `data_security` | `master` | shared current worktree | `gateway/lib/enrolled-device-route-policy.js`; `gateway/server.js`; `gateway/test/enrolled-device-route-policy.test.js` | complete | `67d2447b`; deny high-authority Device routes |
| UX/demo | `ux_demo_plan` | `master` | shared current worktree | none, read-only | complete | Mobile flow/state/demo delivered |
| Verification/release | primary agent | `master` | shared current worktree | guarded release commands and receipts; no feature source ownership | complete for P0 | production `b3517269` healthy; release control ready |

## Planned Implementation Ownership

These claims are reservations, not authorization to start. The coordinator
refines exact paths before each ticket and records status here.

| Lane | Primary ownership | Must serialize with | Merge/deploy criteria |
| --- | --- | --- | --- |
| Account/security | gateway auth/session policy, identity migrations, tenant storage adapters, negative auth tests | development API and release service when principal contract changes | cross-user/device denial, revocation, HTTP/WS parity, additive rollback-safe migration |
| Android recovery/UI | Android voice failure state, navigation, Work/Releases/Settings UI, cached signed rescue | Android shared activity/overlay controllers | lint, assemble, unit/UI tests, source-size, signed preview APK, no active-session interruption |
| Intake/planning | development request domain, list/detail/plan APIs, feedback bridge | account principal contract and worker coordinator | idempotency, plan-before-start, tenant ownership, narrow Device capability |
| Worker/integration | task leases, receipts, path claims, serial integrator, conflict repair | intake domain and release handoff | exact before/after commits, frozen checks, distinct verifier, unresolved semantic conflict fails closed |
| Release lifecycle | release migrations/service/history/composition/promotion and contract fixtures | account principal contract, integrator output, Android release parser | N-1 parsing, stale-sequence denial, exact-byte history/undo, full promotion evidence |
| Independent verifier | fixtures and black-box tests only; no implementation ownership | all lanes after handoff | replays frozen acceptance demo and full surface gates |
| Release operator | guarded packaging, preview, promotion, rollback and smoke receipts | verifier completion | clean committed master, exact candidate SHA/digest, preview smoke, compatibility, drain, rollback, post-promotion smoke |

## Worktree State Convention

Because all lanes intentionally share the primary worktree and `master`, idle is
represented by a clean `master` worktree with no active path claim. No secondary
worktree or branch is created. If a future operator explicitly authorizes a
separate worktree, the repository worktree registry must record its branch,
path claims, candidate, integration state, and closure receipt; it returns to
`master` before it is considered idle.
