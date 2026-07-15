# Conversation host and speaker floor — 2026-07-15

## Raw product direction

- Click/hold captures and sends a message, but only one agent should speak back.
- A launcher may be fresh each turn and may route to existing or new workers.
- Workers need a shared agent-management system they can update and the next
  launcher can inspect.
- A new launcher should inherit a summary of prior launcher turns and active
  work instead of behaving like a new person.
- Stopping the current launcher or speech should not silently stop work it launched.
- Parallel work may finish while the user is speaking or drafting; completion
  must not overwrite or interrupt that draft.

## Bounded implementation decision

Aggie is the durable conversation host. Router/launcher processes are
turn-scoped projections over gateway-owned session, run, and event state.
Workers publish into that management state and never own direct speech.

Every broker context pack now carries `moa.conversation-host.v1` with:

- the stable host and current session/branch identity;
- whether bounded session context was attached and which active runs are known;
- display, queue, and speech rules for foreground and background output;
- distinct controls for stopping speech, starting a new turn, and canceling a run.

## Acceptance check

`cd gateway && npm run test:coverage:broker-launcher`

The test must prove two fresh launcher turns retain the same host identity,
background completion queues while drafts are preserved, and speech stop/new
turn controls preserve detached work unless an explicit run id is canceled.
