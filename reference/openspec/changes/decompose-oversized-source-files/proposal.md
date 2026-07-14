# Decompose Oversized Source Files

## Why

Several production files have accumulated unrelated responsibilities. The
largest, `gateway/server.js`, is over 15,000 lines and combines HTTP routing,
model adapters, voice, browser evidence, agent execution, persistence, profile
control, and device tooling. This makes review, coverage, ownership, and safe
change isolation materially harder.

## Policy

- New production source files must not exceed 2,000 lines.
- Total owned production source should first be reduced toward 60,000 lines,
  then re-evaluated against retained product scope.
- Test-to-production size is reported but not capped; adversarial and matrix
  tests must not be deleted to improve a ratio.
- Executable production coverage must reach at least 90% for lines, branches,
  and functions per deployable surface, not through one blended repository number.
- Existing files above 2,000 lines are explicit migration debt with a fixed
  non-growth ceiling.
- Each extraction preserves behavior, adds focused unit tests, and keeps the
  existing surface verification green.
- Domain modules own bounded data transformations. The gateway entrypoint
  should eventually contain composition, startup, and route registration only.

## First Milestone

Extract browser-evidence normalization and sanitization from the gateway
entrypoint, add direct unit tests, and add an automated repository source-size
policy check.
