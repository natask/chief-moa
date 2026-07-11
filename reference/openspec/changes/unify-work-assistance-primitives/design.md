# Design

## Layers

```text
Chief Moa product
  -> Moa platform surface
  -> local Observation
  -> inert Assistance Suggestion
  -> accepted Aggie Intent / broker_event
  -> route decision
       |-> direct answer
       |-> link/create Task in Project + Workstream + Thread context
       |-> select reusable Workflow
       `-> explicitly launch Run (linked to intent, Task, or Work Node)
              |-> Artifact
              `-> local Action Proposal -> Approval + Receipt
```

Chief Moa is the product and surface family. Aggie owns canonical personal-agent
continuity/routing, not local device authority. A Surface owns UI, permissions,
capture, approvals, execution, and receipts for its platform.

Projects organize durable areas of focus. Workstreams organize lines of progress
that may cross projects. Sessions/Threads organize conversation. Tasks organize
desired outcomes. Runs are attempts. Workflows are reusable procedures. These
objects link; none should absorb the others.

## Promotion rules

Observation is ephemeral evidence and cannot route or execute. An Assistance
Suggestion is visible, expiring, and inert. User acceptance may create at most
one `broker_event` intent for a suggestion type whose disclosed contract
promotes into the broker. The broker may answer directly, link/create a Task,
recommend a Workflow, and/or explicitly launch a Run linked to the intent, a
Task, or a Work Node. A Run can produce an Artifact or Action Proposal; each
local Surface validates and approves/receipts any mutation.

## Compatibility

- `branch_id` remains storage/API compatibility for Thread.
- `work_task` remains the canonical stored Task.
- Existing `project_id`/`subproject_id` hints migrate toward Project plus
  `parent_project_id`; no new subproject object type.
- Existing work graph nodes remain internal decomposition.
- `agent_fork` remains a legacy stored name; product copy says spawned Run.
- Existing `browser_task`/`browser_agent_task` remain transport records.
- Historical Agee/A.G. names may remain in package/storage keys while new product
  copy and protocols use Aggie.

## Surface presentation

Small overlays show current observation scope, a short suggestion, approval, and
run status. Full apps/project pages own deep Projects, Workstreams, Threads,
Tasks, Runs, history, settings, and receipts. Every Surface advertises honest
capabilities rather than pretending macOS/Windows/Android/browser/iOS parity.
