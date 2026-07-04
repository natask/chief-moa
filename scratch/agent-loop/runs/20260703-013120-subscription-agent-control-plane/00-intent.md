# Intent: Subscription, Agent Account, Chat History, And Work Progress Control Plane

## Raw User Goal

The user wants a central place for managing subscriptions, especially AI-related
subscriptions, and for launching agents that can use those subscriptions through
one signed-in server. The server should maintain OAuth grants, session
credentials, expiry state, notifications, and quick update paths when access
breaks.

The user also wants research into whether anyone has already built related
systems: account/session provisioning for agents, systems that can create and
manage agent-owned accounts legitimately, email/session setup flows, and a clear
easy-to-use control panel.

The user wants chat-history management across all AI applications on this
device. CH/common-chat already exists locally and must be inspected. The target
is to find all prior requests across chat histories, recover open threads, and
make sure each one can make forward progress.

The user explicitly asked for continued autonomous progress, subagents, and a
project-management system that launches agents automatically against specific
projects/work items.

## Success Looks Like

- A research report identifies existing products/projects to reuse, integrate,
  or learn from for:
  - credential/subscription/OAuth vaulting for agents
  - legitimate account/session provisioning for agent work
  - chat-history indexing, search, and task extraction
  - agent orchestration and project-progress tracking
- Local CH state is inventoried read-only across Codex, Claude Code, Gemini, and
  OpenCode history on this machine.
- The result maps onto Chief Moa primitives: gateway auth, broker events,
  route decisions, context packs, agent runs, work nodes, artifacts, approvals,
  receipts, and device clients.
- A durable OpenSpec-style plan and Fabro workflow exist under scratch so later
  agents can continue without depending on chat memory.
- The plan distinguishes safe delegated use from abusive signup automation or
  provider policy circumvention.

## Explicit Non-Goals / Boundaries

- Do not mutate the live Chief Moa app or any LaunchAgent/dev service.
- Do not deploy or promote changes.
- Do not read or print `.env` files or secrets.
- Do not create fraudulent accounts, bypass paywalls, evade ToS, or automate
  provider signup flows in a way that violates provider policies.
- Do not launch one agent per raw chat transcript until transcripts have been
  triaged into actionable work items; there are thousands of local sessions.

## Target Repo / Subsystem

Repo: `/Users/natnaelkahssay/projs/chief-moa`

Likely subsystems after research:

- Gateway credential vault / integration registry
- Broker route decisions and context-pack creation
- Work graph / artifact store
- CH/common-chat import and task extraction
- Android/browser control center surfaces

## Current Uncertainty

- Which existing system is closest to the requested credential/subscription
  control plane.
- Whether CH already has enough indexing/search/project extraction to serve as
  the chat-history substrate.
- Which local chat-history sessions contain still-open actionable requests.
- Whether Fabro, CH, and Chief Moa broker/work artifacts should be joined by an
  adapter or consolidated into one gateway-backed project/work graph.
