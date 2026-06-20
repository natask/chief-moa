# Agent Workflow

This project should not depend on chat memory. Each substantial session should
leave artifacts that another agent can resume.

## Work Loop

1. Capture intent.
   - Save the user's raw nouns and success criteria.
   - Do not smooth away product language that may become a ticket boundary.

2. Critique before planning.
   - Look for missing primitives: session, branch, run, action, approval,
     receipt, gateway route, storage, verification, ownership.
   - Identify the smallest milestone that creates observable progress.

3. Write or update an OpenSpec change.
   - Use OpenSpec for product behavior, APIs, data contracts, and staged tasks.
   - Keep the active product map in
     `openspec/changes/define-android-core-product-map` until it is archived.

4. Convert the plan into tickets.
   - One ticket is one observable outcome.
   - Each ticket names files, acceptance criteria, and verification before code
     changes start.
   - Independent tickets can go to separate agents; shared-file tickets run in
     sequence.

5. Implement with narrow context.
   - Give an agent only `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, the relevant
     OpenSpec/task, target files, and verification command.
   - Avoid dumping logs, screenshots, old transcripts, or unrelated docs into
     every context window.

6. Verify and record evidence.
   - Run the narrowest real command that proves the ticket.
   - If verification fails, make the failure visible instead of silently changing
     the plan.

7. Update the architecture only when it changes.
   - Do not let implementation invent hidden behavior.
   - If a new primitive, route, store, trust boundary, or approval class appears,
     update `ARCHITECTURE.md` and the relevant OpenSpec.

## Agent Routing

- Android UI, overlay behavior, visual state, or phone UX: UI agent or current
  session with Android build verification.
- Gateway routes, persistence, harness execution, or model routing: backend
  agent or current session with `npm run check` and endpoint smoke tests.
- Workflow, skills, ledgers, commands, or agent context packs: workflow agent.
- Cross-cutting product behavior: OpenSpec first, then implementation tickets.

## Context Pack Template

Use this when starting a fresh agent:

```text
Read:
- README.md
- ARCHITECTURE.md
- AGENTS.md
- <active OpenSpec or task file>
- <target source files>

Task:
- <one observable outcome>

Constraints:
- preserve Android/gateway trust boundary
- no provider keys in Android
- no hidden phone actions from model output

Verification:
- <exact command or manual check>
```

## Default Next Work

The active implementation path is still the Android core product map:

1. Make Android-created agent runs non-blocking and observable.
2. Add gateway lifecycle controls and cancellation.
3. Stabilize session, branch, and voice event identifiers.
4. Add local phone action approvals and receipts.
5. Build the full-app control center around sessions, runs, approvals, and
   settings.

