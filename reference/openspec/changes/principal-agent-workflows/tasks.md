# Tasks

## 1. Selectable Principal Profiles — First Slice

- [x] 1.1 Add checked-in launcher profiles and workflow packages for
  `security`, `simplification`, and `fuzzing`.
- [x] 1.2 Route explicit spoken/text role intent ahead of generic QA/coding.
- [x] 1.3 Store principal role, execution policy, role constraints, and repair
  handoff in broker context packs.
- [x] 1.4 Preserve selection-without-execution and one-run-only explicit broker
  activation.
- [x] 1.5 Add focused launcher/router tests and message-broker smoke assertions.

Acceptance: each role is selectable from a typed or transcribed broker event;
its context pack carries the checked-in contract; no selection auto-launches;
one explicit activation launches exactly one non-blocking run.

## 2. Worker-Isolated Exact-Candidate Evidence

- [ ] 2.1 Bind principal launch metadata to the configured worker project and
  create one per-run worktree through `worker-workspace` before execution.
- [ ] 2.2 Record the exact before snapshot and candidate/configuration identity
  through work history; fail closed when isolation cannot be proven.
- [ ] 2.3 Record structured finding, minimization, deduplication, diff, and
  verification artifacts without storing secrets or sensitive raw user data.

## 3. Bounded Repair And Independent Verification

- [ ] 3.1 Add a user-approved repair-contract transition from one accepted
  finding to one separately isolated repair run.
- [ ] 3.2 Freeze evaluator/probe/corpus evidence so a repair cannot weaken its
  acceptance test.
- [ ] 3.3 Add an independent verifier assignment and require a distinct run and
  worker identity before a security finding closes.

## 4. Multi-Principal Coordination

- [ ] 4.1 Define ownership, budgets, conflicts, result joining, and merge policy
  for concurrent principal runs.
- [ ] 4.2 Add explicit multi-principal launch only after the coordination
  contract is verified; keep the first slice one principal run at a time.

## 5. Recurring Maintenance

- [ ] 5.1 Define opt-in schedules, quiet periods, cost/resource budgets,
  pause/cancel, evidence retention, and user notification policy.
- [ ] 5.2 Add recurring security/simplification/fuzzing runs only after the
  worker-isolation and repair/verification stages pass.

## 6. Verification

- [x] 6.1 Run focused broker router/launcher tests.
- [x] 6.2 Run `npm run smoke:message-broker`.
- [x] 6.3 Run `openspec validate principal-agent-workflows --strict` when the
  checkout's OpenSpec CLI accepts the change schema.
- [x] 6.4 Run the full gateway `npm run check`.
