## Context

The user wants every message to be understood against the ongoing body of work:
existing sessions, projects, subprojects, active agents, and prior user
messages. A message can mean "continue that thing", "start another thread",
"feed this to all active agents", "invoke a research workflow package", or "answer
directly."

The broker is the layer that makes that decision explicit and durable before a
provider/model session handles the content.

## Goals / Non-Goals

**Goals:**

- Store every inbound user message once as a canonical event.
- Evaluate the message against active sessions, projects, subprojects, and runs.
- Route the event to existing work, new forks, workflow packages, or direct answer paths.
- Preserve route decisions and reasons so the user can inspect why something
  happened.
- Let active sessions receive the message as evidence without forcing
  interruption or cancellation.
- Let workflow packages trigger model/tool/research workflows with focused
  context packs.

**Non-Goals:**

- No hidden local action execution from broker output.
- No requirement to send every message to every expensive model path.
- No provider-specific session memory as the source of truth.
- No replacement for explicit user approvals on device or browser actions.

## Decisions

### Decision: Broker Events Are Canonical

Every inbound voice or text message becomes a `broker_event` with source,
session/project hints, normalized text/transcript, profile version, and evidence
references. Downstream chat turns, voice turns, and agent runs refer back to
that event instead of each storing their own isolated interpretation.

Alternative considered: let each provider session decide continuation from its
own context. Rejected because provider memory is not durable, queryable, or
shared across active agents.

### Decision: Routing Is Multi-Target And Non-Interrupting

The broker can route one message to multiple targets. It may attach the message
to active runs, continue one session, launch a new fork, and invoke a workflow
package. It does not cancel existing work unless the user asks for cancellation
or the target's policy says it should self-dismiss.

Alternative considered: route to exactly one active session. Rejected because
the desired interaction is parallel: multiple sessions can keep working while
new messages arrive.

### Decision: Workflow Packages Are Directory Targets

The broker represents named workflow targets as directories with instructions,
input contracts, context requirements, and expected outputs. For example, a
research request can select the landscape-research workflow directory, fan out
model/tool passes, perform web search, refine, and return a report. Simpler
questions can skip that expensive workflow and answer directly.

Alternative considered: make the main model silently decide all tool use.
Rejected because the user wants inspectable, reliable workflow selection and
optimal-path behavior, not hidden prompt magic.

## First Slice

1. Add OpenSpec capability and task map.
2. Add a gateway broker endpoint that stores a message and returns deterministic
   route candidates/reasons from existing sessions and active runs.
3. Add a smoke proving a message can be routed to an existing session and can
   produce a "new fork" recommendation without canceling active work.
4. Later: connect workflow package invocation and multi-model research fanout.
