# Durable development plane

## Why

The repository stores intents, work nodes, runs, QA evidence, and releases in
separate systems. None owns the full path from one user riff to one accepted
candidate. Agents can stay busy while the requested product remains unfinished.

## What changes

- Store the user's raw riff before planning.
- Bind one dependency graph to that durable intent.
- Derive parallel work from dependency, path, memory, and worker limits.
- Run dependent work in order.
- Require independent QA before freezing the final candidate.
- Record the user's accept or reject decision against the exact candidate.
- Keep integration and release as later effects driven by the accepted record.

## Acceptance

After a gateway restart, one read returns the original riff, the task graph,
task and QA state, the frozen candidate, and the user's exact decision.
