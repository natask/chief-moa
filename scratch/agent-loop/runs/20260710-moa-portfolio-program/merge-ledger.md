# Merge ledger

## Run

- Run id: `20260710-moa-portfolio-program`
- Base branch observed: `agent/voice-pipeline-orchestration`
- Active application policy: read-only diagnosis; no restart, deploy, or active
  data mutation during planning.
- Current unit: durable portfolio goal and P1 implementation contract.

## Research lanes

| Lane | Ownership | Result | Mutation |
|---|---|---|---|
| voice inventory | voice/profile/sampler/TTS/context/tools | complete; evidence packet received | none |
| platform inventory | browser/CDP/self-extension/deploy/self-host/native surfaces | complete; evidence packet received | none |
| adversarial audit | goal correctness, anti-gaming, security/trust | `BLOCK` single-goal implementation; staged program required | none |

## Decisions

- Existing voice sampler/profile/tweak/deploy architecture is treated as partial
  implementation, not as proven end-to-end completion.
- P1 voice reliability/diagnostics is the first coherent implementation unit.
- Same-turn voice change means a defined next segment/utterance boundary; true
  mutation of already-rendered audio is out of scope.
- Browser arbitrary redesign and autonomous deployment require new typed
  contracts and may not bypass current proposal/claim/receipt boundaries.

## Planned implementation lane

- Branch: `agent/voice-reliability-diagnostics` (to be created from a clean,
  verified base when implementation begins).
- Worktree: sibling isolated worktree; never the tree backing the active app.
- Contract: `contracts/contract_voice_reliability_diagnostics.md`.
- Merge gate: contractor contract audit, focused implementation, specialized
  auditor ring, repair cycle, manager rerun of all commands, committed unit,
  isolated preview/artifact, then promotion gate evaluation.

## Active wave 1 lanes (2026-07-10)

| Lane | Branch/worktree | Ownership | State |
|---|---|---|---|
| voice observability | `agent/voice-observability`; `chief-moa-worktrees/voice-observability` | gateway diagnostics, phase evidence, fault tests | active; pre-existing uncommitted work preserved |
| voice product contract | `agent/voice-product-contract`; `chief-moa-worktrees/voice-product-contract` | voice OpenSpec reconciliation and switching semantics | active; pre-existing uncommitted work preserved |
| browser voice sampler | `agent/browser-voice-sampler`; `chief-moa-worktrees/browser-voice-sampler` | extension-only sampler consumption and focused verification | active; manager creates lane from `c9af02a` |

The main orchestrator owns serial integration. Section managers may commit their
lanes but may not merge, deploy, reload the extension, or restart active services.

## Wave 1 repair cycle 1

Initial specialized auditors returned `BLOCK` on all three candidates. Repairs
used CLI-native Codex with `gpt-5.4`, `xhigh` reasoning, in the existing isolated
worktrees. The configured `gpt-5.6-sol` launch was attempted first but rejected
by the installed CLI as requiring a newer Codex version; it performed no work.

| Lane | Initial commit | Auditor blocker | Repair commit | Manager verification |
|---|---|---|---|---|
| voice observability | `3c1c553` | incomplete phase model/query/fault matrix and unsafe error evidence | `587479e` | `gateway npm run check`: 155 pass, 1 skip, 0 fail |
| voice contract | `ce682eb` | missing normative specs, ambiguous clock/auth/retention and false semantic confidence | `c8200d5` | both strict OpenSpec validations pass |
| browser sampler | `3830c1e` | socket terminal handling and async cancel/supersession races | `b16d642` | verify + 6 lifecycle tests + focused sampler smoke + real headless extension smoke pass |

Fresh read-only re-audits are active. No repair is eligible for integration until
those auditors return `PASS` or a subsequent repair cycle clears every blocker.

## Wave 1 integration result

- Gateway repaired head: `6ff4725`; final focused blockers cleared, then
  cherry-picked as `346d508`, `18bdf91`, `a6321a3`, and `b840249`.
- Voice contract repaired head: `28f4367`; target/current semantics and exact
  command names cleared, then cherry-picked as `49a73d9`, `712f967`, `bca6a6a`,
  and `6d2e9ad`.
- Browser sampler repaired head: `b539074`; cross-tab revocation audit `PASS`,
  then cherry-picked as `fc0574b`, `8f11baf`, and `7a6d573`.
- Integration conflicts were limited to preserving existing voice drain-status
  assertions/functions alongside the new diagnostics assertions/functions.

Combined verification on the integration branch:

- `cd gateway && npm run check`: 155 pass, 1 intentional skip, 0 fail.
- `cd browser_extension && npm run verify && node
  scripts/smoke-voice-sampler.mjs && npm run smoke`: pass, including seven
  lifecycle cases and real headless Chrome extension smoke.
- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew
  assembleDebug`: build successful.
- Both strict voice OpenSpec validations: pass.

Artifacts:

- Extension: `browser_extension/dist/A.G.-0.1.28.zip`, SHA-256
  `d21484f8b411028608001d8d08f473e73c559331403ac1afab1e770fe3e70d57`.
- Android debug APK: `android_app/app/build/outputs/apk/debug/app-debug.apk`,
  SHA-256 `1dd4e077ac81400750b7dba2808183e61405ca9e97078761c8dbb933800270ff`.

Active promotion remains gated. The extension package was created without
reloading the user's active browser. Gateway active apply was not attempted:
this run does not yet contain an isolated preview URL/state store plus fresh VPS
backup/restore, drain/no-active-turn, compatibility, and rollback evidence for
the integrated commit. Android OTA was not published because this Wave contains
no Android source change and active-phone interruption state was not proven.

## Integration status

- No implementation branch created.
- No code merged.
- No deployment or preview created; this unit is planning-only and
  non-deployable.

## Remaining manager proposals (2026-07-10)

Launch-ready packets and the dependency DAG are in `portfolio-managers.md`.
Proposed managers are MF identity/data, MT telemetry/observability, M3 context,
M4 control plane, MB billing, M5 protocol/native surfaces, M6 companion sharing,
and MX final integration. Their research/contract passes may run concurrently;
authority/schema integration is serial in the order recorded there. These are
planning proposals, not implementation, benchmark or production-readiness
claims. Tier 0 selects the current base, launches lanes, integrates green
commits, runs combined gates and alone evaluates preview/promotion authority.

## P2 bounded UI-spec integration (2026-07-10)

- Candidate plus three repair commits were integrated serially as `f08c93a`,
  `4f7f038`, `2c174c8`, and `538d0fb`.
- Auditor cycles: initial `BLOCK` (global scope, fake proof, fanout, untested
  renderer); repair `BLOCK` (fake gateway, dispatch unproven, post-traversal
  caps); repeatability `BLOCK` (1/3 timeout, nested traversal); final manager
  repair diagnosed asynchronous config seeding as the race and added bounded
  nested read-count canaries.
- Combined integration evidence: gateway `npm run check` 155 pass, 1 skip, 0
  fail; extension verify pass; actual isolated gateway + unpacked Chrome UI
  smoke passed five consecutive times in the lane and three consecutive times
  after integration; general real-extension smoke pass.
- Artifact: `browser_extension/dist/A.G.-0.1.29.zip`, SHA-256
  `783b2711c881c4e1f074e2df1040153f4e15da35cdff1ae67c03c1925c56b7f1`.
- No active browser reload or gateway promotion was attempted. The package is a
  rollbackable artifact; active-session/drain evidence remains absent.
