# Unify Work and Assistance Primitives

## Why

Chief Moa already stores sessions, branches, broker events, work tasks, runs,
workflows, artifacts, proposals, approvals, and receipts, but product language
still conflates the platform, assistant, surface, conversation, project, task,
and execution. Proactive help adds another boundary that must be explicit:
observed evidence is not user intent, and a suggestion is not a task or action.

## What Changes

- Define Chief Moa as product/surface family and Aggie as the canonical personal
  agent/session layer; keep A.G. as presentation alias.
- Add Observation, Assistance Suggestion, Project, and Workstream primitives.
- Expose Thread as the user term while retaining `branch` in storage/APIs.
- Reserve Workflow for reusable procedures, Task for desired outcomes, Work Node
  for decomposition, and Run for one execution attempt.
- Define the only valid observation-to-intent promotion boundary, followed by
  explicit optional routing branches for direct answers, tasks, workflows, runs,
  artifacts, and locally approved actions.
- Stage durable Project/Workstream projections and compatibility mapping rather
  than renaming live identifiers in place.

## Capabilities

### New Capabilities

- `work-assistance-taxonomy`: canonical product language and state boundaries,
  including the inert suggestion lifecycle and a staged Project/Workstream model
  distinct from conversation and execution state.

## Impact

This change first updates documentation and guides the privacy-first browser
helper. Gateway Project/Workstream persistence, suggestion-to-broker promotion,
and cross-surface deep project UI remain staged implementation work with their
own migration and verification gates.
