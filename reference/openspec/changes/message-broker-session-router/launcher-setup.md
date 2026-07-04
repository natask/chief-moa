# Intent Runtime Launcher Setup

## Recovered Ask

The product should not behave like a one-way chat box. Every typed or spoken
message should be stored as durable state, routed against prior sessions,
projects, subprojects, active runs, and available workflow directories, then
packaged with the smallest relevant context needed to act. A message may
continue an existing session, attach evidence to active agents, create a new
fork, invoke a research or QA workflow, or take the direct-answer path.

The requested setup is not more content in `AGENTS.md`. The launcher/router
should decide which workflow directory and verification checks a spawned agent
gets. That decision should be stored in repo/gateway artifacts so future agents
can inspect it and test it.

## Implemented Setup

- `gateway/agent-launcher-profiles.json` is the editable router profile file.
  It maps direct-answer, coding, QA, research, design, and writing routes to
  workflow directories, instruction files, context files, expected outputs, and
  verification checks.
- `gateway/agent-workflows/<workflow>/WORKFLOW.md` contains the directory-backed
  instructions for each route.
- `POST /v1/broker/messages` stores a broker event, emits route decisions, and
  materializes one bounded context pack per route decision.
- Context packs are stored under `DATA_DIR/broker-context-packs` and linked from
  both the response and persisted broker event.
- `agent_run` evidence routes append `broker_evidence_attached` to the target
  run event log without canceling that run.

## Verification Contract

Run:

```sh
cd gateway
npm run smoke:message-broker
```

This must prove auth, event persistence, session continuation, context-pack
creation, research routing, QA routing, new-fork recommendation, and active-run
evidence attachment.

## Still Open

- Automatic creation of forked `wait=false` runs from a broker decision.
- Real research fanout with search/model passes and stored workflow output.
- Continuous 200 ms intent runtime with cost, cadence, and ignored-response
  guards.
