# Mobile multi-agent launcher intent

## User outcome

From Android, the user can speak or type a long mixed message and turn the
project parts into durable work. The user does not need to rewrite the whole
message.

Before launch, Moa shows the proposed split. The user can edit it, name the
agents, choose the lanes, and start independent lanes in parallel.

## Product contract

- Keep the original voice or text as immutable source evidence.
- Link each proposed intent to its source segment.
- Do not treat every sentence as a task.
- Classify each segment as project work, personal reflection, unclear, or
  conversational.
- Keep excluded segments reviewable. Do not add personal reflection to project
  context or launch work from it unless the user promotes it.
- Show a launch preview with the objective, agent name, context pack, expected
  result, dependencies, permissions, and verification.
- Launch approved independent lanes in parallel within visible resource limits.
- Queue dependencies until their prerequisites finish.
- Give each agent a stable run id and editable display name.
- Show active, waiting, blocked, complete, failed, and cancelled runs on mobile.
- Let the user open one agent, read its focused conversation and artifacts, send
  a follow-up, or cancel it without interrupting other agents.
- Store source intent, split revisions, approvals, routes, context packs, run
  events, results, artifacts, blockers, and receipts in gateway-owned state.
- Use Android as the control surface and local cache.
- Return a short combined result while keeping each agent's exact result and
  evidence available.
- Require explicit authority for code changes, local actions, merges, and
  deployments.

## First observable milestone

On Android, submit one mixed voice or text message. Exclude one personal segment.
Approve three named independent lanes. Launch them without blocking the app.
Open each lane by name. Send a follow-up to one agent. Restore the same run,
status, and result view after the app restarts or from another surface.

## Acceptance evidence

Gateway tests prove source links, revision-bound approval, parallel launch,
dependency queues, durable recovery, and personal-segment isolation.

Android phone QA proves preview, edit, launch, agent switching, follow-up, and
restored status after relaunch.
