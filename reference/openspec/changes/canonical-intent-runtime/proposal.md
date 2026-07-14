## Why

Chief Moa can store conversations, branches, broker events, work tasks, work
nodes, runs, and artifacts, but none is the durable object the user actually
cares about: one desired outcome. The fragmented stores make it impossible to
reliably answer what the user intended, how it changed, what is blocking it,
what evidence exists, and where focus should return after a temporary command.

## What changes

- Add a canonical, event-sourced intent aggregate over the existing product
  event substrate.
- Capture non-incognito turns before routing, launch, tools, or answer
  generation.
- Make route-before-answer a real admission boundary so clean-slate and
  incognito turns do not see caller-thread history.
- Add typed intent relations and a focus push/pop lifecycle for temporary
  transactional child intents.
- Add a bounded, source-linked project/intent rehydration brief.
- Keep sessions, threads, repo bindings, work nodes/tasks, runs, artifacts, and
  telemetry as explicit containers, projections, or evidence.

## Non-goals

- No second JSON intent database.
- No generic project-management UI in this slice.
- No ungrounded model-generated project summary.
- No provider memory or telemetry as product authority.
- No live promotion without the repository safety gate.

## Impact

- Gateway intent domain, event integration, route admission, profile-control
  receipts, authenticated read APIs, and tests.
- Context-thread OpenSpec and architecture wording.
- Android/browser surfaces consume intent IDs and focus receipts additively;
  they do not invent intent state locally.
