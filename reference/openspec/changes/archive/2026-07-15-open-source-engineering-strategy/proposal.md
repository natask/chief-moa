## Why

Open source raises the bar for repo legibility. If contributors, users, or
agents cannot tell where a change belongs, how it should be verified, or what
the trust boundary is, the project will accumulate broad patches and hidden
decisions.

## What Changes

- Add a contributor guide that explains owner tracks, verification commands,
  trust-boundary rules, specs, tickets, and pull request expectations.
- Add an engineering strategy map that turns the architecture into practical
  contribution rules and a definition of done.
- Link the new entrypoints from the README so first-time readers do not have to
  infer the workflow from scattered docs.
- Track the work through an agent-loop run and Fabro workflow so the decision is
  resumable.

## Capabilities

### New Capabilities

- `open-source-engineering-strategy`: Contributor-facing engineering strategy
  that maps work to owner surfaces, verification loops, OpenSpec usage, and a
  concrete definition of done.

## Impact

- Root docs: `README.md`, `CONTRIBUTING.md`, `ENGINEERING_STRATEGY.md`.
- Workflow artifacts: `scratch/agent-loop/runs/<run-id>` and
  `.fabro/workflows/open-source-engineering-strategy`.
- Verification: inspect changed docs, validate Fabro workflow when available,
  and validate the OpenSpec change when the CLI is available.
