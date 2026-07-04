# Engineering Strategy

Chief Moa should be open-source without becoming hard to navigate. The strategy
is to make the repo legible as a set of owned surfaces, durable specs, narrow
tickets, and repeatable verification loops.

## Product Boundary

The system has four owner surfaces:

| Surface | Owns | Does not own |
| --- | --- | --- |
| Android app | Phone UI, overlay, voice capture, permissions, approvals, local action execution, receipts | Provider credentials, long-running harnesses, model routing |
| Gateway | Auth, model/provider calls, voice routing, storage, agent-run records, harness launch, Android update artifacts | Phone-local authority or direct device actions |
| Browser extension | Browser-local UI, page context, voice capture, allowlisted extension-local browser tasks | Provider credentials, per-user privileged code deployments |
| Execution machine | Repo edits, long-running research, build/test commands, desktop/browser/server automation | Phone or browser authority without local client approval |

If a proposed feature cannot name its owner surface, it is not ready to
implement.

## Work Modes

Use the smallest mode that creates observable progress:

| Mode | Use when | Output |
| --- | --- | --- |
| Direct fix | A bug or doc gap has one obvious owner and one verification command | Small patch, verification, commit |
| OpenSpec change | Product behavior, data shape, trust boundary, or API contract changes | `reference/openspec/changes/<slug>` with proposal and tasks |
| Agent-loop run | Raw intent needs critique, tickets, workflow, and resumable state | `scratch/agent-loop/runs/<run-id>` plus Fabro workflow |
| Research note | The unknown is external prior art or technical feasibility | `reference/scratch/...` with sources and decision brief |

Do not use a larger mode to avoid making a hard engineering decision. Use a
larger mode only when the problem truly spans ownership, behavior, or sequence.

## Contributor Ladder

Make contribution difficulty explicit:

| Level | Good first work | Acceptance |
| --- | --- | --- |
| 1 | Documentation clarity, broken links, command corrections | The documented command or link is correct |
| 2 | Narrow smoke checks or fixtures | The smoke catches one real behavior without secrets |
| 3 | Gateway pure logic, storage adapters, endpoint summaries | `cd gateway && npm run check` passes plus a focused smoke when needed |
| 4 | Browser extension behavior | `cd browser_extension && npm run verify && npm run smoke` passes |
| 5 | Android UX, permissions, approvals, receipts | Android debug build passes plus manual phone QA when behavior changes |
| 6 | Cross-surface product changes | OpenSpec updated, staged tickets verified by surface |

The repo should always have Level 1-3 work available so contributors can become
useful before they understand the full system.

## Engineering Rules

- One implementation task should have one observable acceptance check.
- Every feature attaches to a product primitive from
  [ARCHITECTURE.md](ARCHITECTURE.md).
- Model output and screen context are untrusted inputs.
- Docs/spec updates travel with architecture-significant code changes.
- Verification evidence belongs in files, not only in chat.
- Completed deployable work is verified, committed, deployed, and smoke-checked.
- Docs-only work is committed with verification and marked non-deployable.

## Roadmap Discipline

Prefer roadmap slices that strengthen the loop:

1. Make the current surface observable.
2. Add lifecycle control.
3. Stabilize IDs and storage.
4. Add approval and receipt boundaries.
5. Build inspection UI around existing durable state.
6. Improve model or voice quality only after the loop is trustworthy.

This keeps open-source work from turning into disconnected features.

## Definition Of Done

A task is done when a future maintainer can answer:

- What product primitive changed?
- Which surface owns it?
- What file records the decision?
- What command or QA check proves it?
- Was deployment required, and what happened?

If those answers are missing, the task is not done yet.
