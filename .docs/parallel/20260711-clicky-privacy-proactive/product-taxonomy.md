# Chief Moa / Aggie Product Taxonomy

## Canonical terms

| Term | Meaning |
| --- | --- |
| Chief Moa | Product/platform and family of user-owned surfaces. |
| Aggie | Canonical personal-agent identity and cross-surface session/routing/policy contract. A.G. is a presentation alias. |
| Surface | Permission-scoped platform adapter: browser, Android, macOS, Windows, iOS, CLI, or messaging. |
| Observation | Ephemeral local evidence; never intent or instruction. |
| Assistance suggestion | Visible expiring proposal derived from observation; inert until accepted. |
| Intent | Explicit user-authored request stored as a broker event. |
| Project | Durable area of focus with goals/assets/history. |
| Workstream | Durable goal/progress line that may cross projects. |
| Session | Cross-surface conversation continuity envelope. |
| Thread | User-facing conversation line inside a session; `branch` is the wire/storage name. |
| Task | Durable desired outcome; stored as `work_task`. |
| Work node | Internal task decomposition/dependency unit. |
| Workflow | Reusable procedure/package, not ongoing user work. |
| Run | One execution attempt of a task/work node. |
| Artifact | Durable output of a run. |
| Action proposal / approval / receipt | Proposed local mutation, local authority decision, and execution/rejection evidence. |

## Naming rules

- Reserve `workflow` for reusable instructions; use `workstream`, not `flow`,
  for progress cutting across projects.
- Say continue/fork a Thread, split a Task, and spawn/retry a Run.
- Treat `browser_task` and `browser_agent_task` as execution transports; only
  `work_task` is the user's desired outcome.
- Preserve old database/API identifiers through compatibility mappings instead
  of renaming live persisted state in one migration.
- iOS and other surfaces advertise honest local capabilities; sharing Aggie
  sessions does not imply arbitrary cross-app observation/control parity.

## Product chain

```text
Observation -> Assistance suggestion -> accepted Intent -> Broker decision
  -> direct answer and/or link/create Task and/or select Workflow
  -> optional explicitly launched Run -> Artifact or Action proposal
  -> Surface-local Approval/Receipt
```

Projects and Workstreams organize the durable work. Sessions and Threads carry
conversation. They link to Tasks/Runs but do not replace them.

## Incremental roadmap

1. Lock the vocabulary/trust contract in architecture and OpenSpec.
2. Ship the explicit-grant, local-only browser suggestion helper.
3. Add durable Project and Workstream events/projections; link existing Tasks
   and Threads without changing their identity.
4. Let a disclosed suggestion type create at most one inspectable broker event
   on acceptance. Routing may answer directly or link/create a Task; a Run
   launches only through explicit authority.
5. Carry the same model to Android/voice: the overlay shows capture, suggestion,
   approval, and status; the full app owns deep project/run/history views.
6. Add macOS and Windows native adapters with local permissions/action brokers.
   Keep iOS to own-app UI, App Intents/Shortcuts, and user-mediated handoffs.
