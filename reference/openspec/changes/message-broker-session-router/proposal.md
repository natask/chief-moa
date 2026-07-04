## Why

Moa needs a message broker in front of voice, chat, workflow packages, and agent runs. A
new user message is not just a chat prompt. It may continue an existing session,
fan out as evidence to active work, create a new project/subproject thread,
invoke a workflow package, or launch a research/implementation workflow.

The product should not rely on the current provider session to infer this. The
gateway should own a durable broker decision layer that records every incoming
message, compares it against active sessions/projects/runs, and emits explicit
route decisions with reasons.

## What Changes

- Add a gateway-owned message broker primitive for all inbound voice/text turns.
- Store every inbound message as a canonical broker event with session, project,
  subproject, source, transcript/text, profile version, and evidence references.
- Maintain queryable sessions, projects, subprojects, and active runs as broker
  candidates.
- Route each message to one or more outcomes: continue an existing session,
  attach evidence to active runs, create a new fork, invoke a directory-backed
  workflow package, or dismiss as irrelevant.
- Make workflow package invocation explicit: the broker can choose research,
  coding, design, writing, QA, or other workflow directories and construct
  focused context packs for each.
- Support deeper research workflows when needed: spawn multiple model/tool
  passes, search broadly, refine, and return a report; but avoid overusing that
  path when the answer is already straightforward.

## Capabilities

### New Capabilities

- `message-broker-session-router`: Durable broker for routing inbound messages
  across sessions, projects, subprojects, workflow packages, and active agent
  runs.
- `workflow-package-invocation`: Broker-selected workflow directories receive
  focused context packs and produce inspectable work products.

## Impact

- Gateway: broker event storage, route-decision API, session/project candidate
  lookup, active-run fanout, and workflow-package launch metadata.
- Android/browser clients: voice/text turns can call the broker before, or as
  part of, voice/chat handling.
- Agent harnesses: receive broker context packs instead of raw chat history.
- OpenSpec: clarifies that messages are durable routing events, not only model
  prompts.
