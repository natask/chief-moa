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

## Active Implementation Wave 1

| Agent/task | Branch | Worktree | Exact path claim | Tickets | State |
| --- | --- | --- | --- | --- | --- |
| `release_own_device` | `master` | shared current worktree | released; release-control service/auth implementation and focused tests | 0.4 | complete: `4af13c0f` |
| `device_revocation` | `master` | shared current worktree | released; device credential registry, additive revocation migration, focused tests | 0.5 | complete: `cb2c8f3e` |
| `android_voice_recovery` | `master` | shared current worktree | released; Android voice failure/draft UI, helpers, and focused tests | 1.1–1.2 | complete: `ad263df7` |
| `named_request_foundation` | `master` | shared current worktree | released; development request domain and focused tests | 3.1–3.2 foundation | complete: `694f87ab` |
| `wave1_verifier` | `master` | shared current worktree | read-only independent review and cross-surface verification | wave verification | active |
| Primary coordinator | `master` | shared current worktree | this index, guarded push/deploy only | wave integration | active |

## Corrective Wave 1B

Independent verification found that Wave 1A was additive but not yet operable:
revocation blocked same-device re-pairing, the new gateway domains had no narrow
routes, and Android recovery intents had no real destination. These path claims
remain disjoint and are required before the wave can be promoted.

| Agent/task | Branch | Worktree | Exact path claim | Exit criterion | State |
| --- | --- | --- | --- | --- | --- |
| `device_revocation` | `master` | shared current worktree | released; credential generations, revocation migration, focused tests | revoked token stays denied; same binding accepts a new credential generation | complete: `45d40857` |
| `gateway_wave1_integration` | `master` | shared current worktree | released; server wiring, narrow credential/request handlers, enrolled-device policy | own-device revoke and tenant-owned named requests are reachable without exposing privileged development routes | complete: `a32f0d05` |
| `android_native_rescue` | `master` | shared current worktree | released; `MainActivity`, recovery dialog, native rescue/cache helpers and tests | reconnect reaches enrollment; rescue works without voice/model and never claims unavailable restore | complete: `2cc8ddc8` |
| `gateway_recovery_read` | `master` | shared current worktree | released; recovery manifest route, enrollment scope, route policy, focused tests | dedicated read-only recovery capability without conversation or mutation authority | complete: `7aa109e6` |
| `wave1_verifier` | `master` | shared current worktree | released; read-only review and cross-surface gates | all P1 findings closed and exact gates green | complete; safe to push/deploy code |

## Corrective Wave 1C

| Agent/task | Branch | Worktree | Exact path claim | Exit criterion | State |
| --- | --- | --- | --- | --- | --- |
| `gateway_wave1_integration` | `master` | shared current worktree | gateway request/credential authority boundary and tests | phones cannot forge progress; recent owner can revoke a lost credential | complete: `45c1b58c` |
| `coordinator_token_ops` | `master` | shared current worktree | Compose and guarded VPS credential installers/tests | distinct coordinator token is generated, collision-checked, and gateway-only | complete: `d8e851d1` |
| `forward_recovery_lead` | `master` | shared current worktree | integration/review across the three disjoint recovery lanes | forward recovery is truthful, continuity-signed, in-place, and pointer-independent | complete |
| `recovery_artifact_pipeline` | `master` | shared current worktree | `android_app/deploy/ota/**` and focused pipeline tests | exact predecessor source produces a newer signed recovery APK with bound provenance | complete: `df763951`, `befe78c8`, `fd0ef66d` |
| `recovery_manifest` | `master` | shared current worktree | gateway recovery provenance/store/handler integration and tests | only exact verified recovery receipts and bytes are projected | complete: `ab7f6918`, `a2cf02c7`, `49c9792a` |
| `android_recovery_install` | `master` | shared current worktree | Android recovery parser/cache/controller/verifier tests | verified forward APK installs in place without silent uninstall | complete: `db75fd92`, `94bfe96d` |

## Active UI Redesign Wave

Every lane uses the shared `master` worktree. No UI lane creates a branch or a
secondary worktree. Audit lanes are read-only. Implementation lanes stage and
commit only their owned paths; they do not push or deploy.

| Agent/task | Branch | Worktree | Exact path claim | Exit criterion | State |
| --- | --- | --- | --- | --- | --- |
| `ui_visual_director` | `master` | shared current worktree | none; read-only audit of all Android and browser UI | unified visual direction, token system, hierarchy, and implementation brief delivered | active |
| `android_visual_audit` | `master` | shared current worktree | none; read-only Android source and rendered-screen audit | prioritized defects and exact Talk/Work/Releases/Settings/overlay recommendations delivered | active |
| `browser_visual_audit` | `master` | shared current worktree | none; read-only extension source and desktop/narrow/side-panel capture audit | severity-ranked responsive audit, capture evidence, and implementation map delivered | active |
| `ui_accessibility_review` | `master` | shared current worktree | none; read-only Android and browser accessibility audit | screen-reader, keyboard, focus, target, contrast, motion, typography, and state-semantics findings delivered | active |
| `ui_test_strategy` | `master` | shared current worktree | none; read-only Android and browser visual-QA audit | automated state/viewport/interactivity/accessibility matrix and exact test-extension map delivered | complete |
| `claude_design_critic` | `master` | shared current worktree | none; read-only design critique | Claude access attempt recorded and independent screenshot/source redesign brief delivered | complete; Claude subscription disabled by organization |
| `android_wow_ui` | `master` | shared current worktree | `android_app/app/src/main/java/ag/companion/{MainActivity.java,MoaColors.java,MoaDrawables.java,MoaMainNavigation.java,MoaTalkHomeView.java,MoaDevelopmentRequestsView.java,MoaSectionHeaderView.java,MoaReleaseCardController.java}`; new Android drawables; direct unit/capture tests | cohesive premium four-destination UI; all screens visually inspected; focused, lint, assembly, unit, and source-size gates pass | active |
| `browser_workspace_wow` | `master` | shared current worktree | `browser_extension/extension/{sidepanel.html,sidepanel.js}`; new `sidepanel.css`; direct side-panel visual/smoke tests | premium responsive Now/Library/Control workspace; narrow/wide captures inspected; browser and source-size gates pass | active |
| `browser_overlay_wow` | `master` | shared current worktree | `browser_extension/extension/{overlay.css,ribbons.css,media-confirm.css}`; `media-confirm.html` only if required; direct overlay/ribbon visual tests | premium mascot-anchored compact/expanded capsule; reduced-motion and host isolation preserved; real captures and browser gates pass | active |
| `browser_overlay_wow/overlay_visual_audit` | `master` | shared current worktree | none; read-only overlay CSS/DOM audit | exact visual findings returned to overlay implementation owner | active |
| `browser_overlay_wow/overlay_test_map` | `master` | shared current worktree | none; read-only overlay test and screenshot-route audit | exact visual-test coverage map returned to overlay implementation owner | active |
| `browser_settings_wow` | `master` | shared current worktree | `browser_extension/extension/{options.html,options.js}`; new options CSS; direct options-page visual/smoke tests | premium grouped settings experience with preserved behavior; responsive captures inspected; browser and source-size gates pass | active |
| `web_console_wow` | `master` | shared current worktree | `gateway/public/{console.html,development.html}`; direct page CSS and tests | premium responsive conversation and development consoles; existing contracts preserved; real captures and focused gates pass | active |
| `web_auth_wow` | `master` | shared current worktree | `gateway/public/{sign-in.html,device.html}`; direct page CSS and tests | cohesive trustworthy sign-in and device enrollment; responsive/accessibility captures inspected; focused gates pass | active |
| `web_operator_wow` | `master` | shared current worktree | `gateway/public/{gateway-ui.html,credential-panel.html}`; direct page CSS and tests | clear premium operator and credential surfaces; operational behavior preserved; responsive captures and focused gates pass | active |
| `web_inline_auth_wow` | `master` | shared current worktree | `gateway/server.js` `sendAccountHtml` and `sendAccountSecretForm` only; direct tests | inline account/auth pages match the visual system without changing server authority or unrelated routes; focused gateway gates pass | active |
| `cross_surface_accessibility` | `master` | shared current worktree | Android `OrbView.java`, `MoaOrbTouchListener.java`, `MoaMinimalEdgeView.java`, `MoaRibbonTokens.java`; browser `ribbon-runtime.js`, `content.js`; direct tests | accessible touch, focus, announcements, motion, and ribbon behavior align across Android and browser; focused platform gates pass | active |
| `ui_agent_index` | `master` | shared current worktree | this index only | UI audit and implementation claims remain current; docs-only conventional commit | active |
| Primary coordinator | `master` | shared current worktree | cross-lane integration, independent verification, guarded push/deploy | owned-path commits integrated; visual, accessibility, behavior, build, and source-size gates pass before deployment | active |

## Worktree State Convention

Because all lanes intentionally share the primary worktree and `master`, idle is
represented by a clean `master` worktree with no active path claim. No secondary
worktree or branch is created. If a future operator explicitly authorizes a
separate worktree, the repository worktree registry must record its branch,
path claims, candidate, integration state, and closure receipt; it returns to
`master` before it is considered idle.
