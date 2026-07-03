# Feedback Intake

Status: awaiting user review.

## Captured During Run

- The user wants one self-hostable interface, not a pile of separate one-off
  tools.
- The user wants all prior chat-history work to become forward progress, but
  the local history scale requires extraction, dedupe, and queueing before
  agent fanout.
- The user wants ongoing progress and automatic agents, but the first safe
  implementation should promote cited tasks into a work graph before launch.

## Triage Decision

Create a follow-up implementation run only after the user approves moving from
research artifacts to code changes. The first implementation should not create
or use external accounts. It should import CH metadata into Chief Moa's broker
or work-artifact layer and display an actionable work queue.

## Follow-Up Candidate

`ch-work-intake-v0`: read-only CH import, extracted task queue, dedupe keys,
status fields, and a gateway endpoint that lets the control center list
candidate work items by project/session/source.

## Decisions To Confirm

- Use Nango-compatible OAuth broker interface first, with the option to back it
  by Nango, Auth0 Token Vault, WorkOS, Scalekit, or a mock provider.
- Use CH as importer/canonicalizer and Chief Moa gateway Postgres as the
  retrieval/task/work store.
- Use Playwright browser profiles as the local session primitive, with
  Browserbase/Browserless/Steel as optional remote providers.
- Use DBOS-style durable Postgres workflows before introducing Temporal or a
  separate workflow cluster.

## Follow-Up Questions

- Which first provider should prove the OAuth connection path: GitHub, Google,
  Slack, or another low-risk service?
- Should the first UI be Android-first, web control-center first, or gateway API
  plus CLI smoke first?
- Should the first CH import scope be only `chief-moa`, or include `moa`,
  `moa-assistant`, `common-chat`, and `agent_launcher` immediately?
