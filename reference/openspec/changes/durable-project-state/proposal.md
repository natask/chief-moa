## Why

Moa can launch agents and store run output, but a saved project only names a
working directory and harness. After time away, the user cannot see what real
problem the project solves, what durable progress exists, or what move is next
without reconstructing it from agent sessions.

## What Changes

- Make a concise project brief part of the gateway-owned project record.
- Store the problem, desired outcome, current state, and next viable step.
- Let the local gateway console edit that state before launching more work.
- Include the saved brief in project-targeted agent launches so disposable
  workers start from the durable object instead of an empty session.
- Keep agent identities and session management secondary to the durable project.

## First Slice

This change does not autonomously choose the next agent. It establishes the
durable state artifact and makes existing project-targeted launches consume it
without depending on chat history.
