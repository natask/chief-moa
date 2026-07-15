# Manual Voice, Modes, And Principal Lanes — 2026-07-15

## Accepted Outcome

- Android and browser use the same single/hold/double/triple manual gesture map.
- Ask, Note, and Coach are explicit delivery modes, not gesture chords.
- Security, Simplification, and Fuzzing are bounded principal workflow roles;
  ordinary feature work remains separate.
- Every implementation lane uses an isolated worktree, narrow evidence,
  Conventional Commits, serial integration, and an explicit promotion state.

## Integrated Lanes

| Lane | Source commits | Evidence before integration |
| --- | --- | --- |
| Browser gestures | `888b6a5a`, `5b08f55f` | verify and real headless-Chrome smoke passed |
| Android gestures | `774b21a7`, `30d45dab`, `1e542437`, `62fa1186` | focused/full unit tests, assembleDebug, diff-check passed |
| Principal profiles | `59e28d12`, `ecf188ec` | 24 focused tests, broker smoke, strict OpenSpec, gateway check passed |
| Ask/Note/Coach gateway | `ba6a6434`, `3a073cbf` | mode tests/smoke/quality/strict OpenSpec passed; unrelated lease-timing failure remained in the concurrent full check |

## Deliberately Staged Next Units

1. Android mode selector/state, admission preflight, and physical-phone QA.
2. Browser mode selector/state and admission preflight.
3. Spoken mode switching as a control turn.
4. `capture_block` plus notebook/transcription; then Dictate/IME.
5. Principal finding schema/fingerprint/dedupe, bounded repair handoff, and
   independent verification receipts.
6. Recurring schedules and a user-facing objective/control-room projection only
   after exact-candidate worktree and retry-budget policy is executable.

No lane in this unit authorizes deployment or automatic repair fanout.
