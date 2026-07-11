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

## Integration status

- No implementation branch created.
- No code merged.
- No deployment or preview created; this unit is planning-only and
  non-deployable.
