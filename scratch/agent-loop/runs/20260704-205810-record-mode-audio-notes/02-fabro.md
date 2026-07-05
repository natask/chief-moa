# Fabro: record mode raw audio notes

## Workflow
- path: `.fabro/workflows/record-mode-audio-notes/workflow.fabro` (main
  checkout; `.fabro` lives at the repo root, shared across worktrees)
- validated: `fabro validate` OK (2 non-blocking retry-target warnings)
- goal: record mode stores raw spoken audio as durable gateway audio notes
  with no STT/LLM/TTS, capturable from extension and Android
- gates: three `goal_gate` verification nodes (gateway check, extension
  verify+smoke, Android assembleDebug) and one human gate for accept +
  gated live-gateway promotion
- artifacts: lane diffs on branch `worktree-record-mode-audio-notes`,
  verification logs in `04-verification.md`, codex log under
  `scratch/codex-subagent/`

## Execution note

This run executes the lanes directly through scoped sub-agents (Claude opus
for extension and Android, codex via the `codex-subagent` skill for the
gateway) rather than `fabro run`, because the lanes were already in flight
when the workflow was materialized. The workflow file is the durable,
re-runnable process for revisions.

Deviation from the codex-subagent skill default: codex shares the existing
`record-mode-audio-notes` worktree instead of getting its own, because the
three lanes touch disjoint top-level directories and one branch should carry
the whole change. Codex is instructed not to commit; the orchestrator commits
per lane.

## Tickets
| id | title | track | depends | acceptance | agent | verification |
| --- | --- | --- | --- | --- | --- | --- |
| T0068 | Gateway audio-note store, routes, smoke | backend | - | POST/GET roundtrip byte-identical, no providers | codex sub-agent | `cd gateway && npm run check` |
| T0069 | Extension record mode capture+upload | ui | - (contract fixed in proposal) | record control captures + uploads, no voice session | claude opus | `npm run verify && npm run smoke` |
| T0070 | Android record mode capture+upload | ui | - (contract fixed in proposal) | toggle + gesture records + uploads | claude opus | `./gradlew assembleDebug` |
| T0071 | Codex adversarial review of diffs | workflow | T0068,T0069 | confirmed findings fixed, checks re-run | codex review | lane checks re-run green |
| T0072 | ARCHITECTURE.md record-mode docs | docs | T0068 | flow + primitive + source map updated | current session | doc inspection |

## Waves
| wave | tickets | rule |
| --- | --- | --- |
| 1 | T0068, T0069, T0070 | parallel; disjoint directories in one worktree |
| 2 | T0071, T0072 | after wave-1 verifications pass |
