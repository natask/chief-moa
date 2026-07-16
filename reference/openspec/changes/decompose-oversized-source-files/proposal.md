# Decompose Oversized Source Files

## Why

Several production files have accumulated unrelated responsibilities. The
largest, `gateway/server.js`, remains over 12,000 lines and combines HTTP routing,
model adapters, voice, browser evidence, agent execution, persistence, profile
control, and device tooling. This makes review, coverage, ownership, and safe
change isolation materially harder.

## Policy

- Owned production and UI source must finish at or below 50,000 physical lines.
  The target counts behavior-bearing UI as well as executable code and cannot be
  met by minification, generated-code relabeling, dependency offloading, or
  deleting tests.
- New production or UI source files must not exceed 2,000 physical lines. This
  is a deliberately generous hard stop for reviewability and model context, not
  the desired module size; composition entrypoints converge to 500 lines or
  fewer and smaller domain-specific files are preferred.
- Test and verification source must remain at or below 2x production source;
  adversarial and matrix tests must not be deleted merely to improve the ratio.
- Executable production coverage must reach at least 90% for lines, branches,
  and functions per deployable surface, not through one blended repository number.
- Existing files above 2,000 lines are explicit migration debt with a fixed
  non-growth ceiling.
- While the repository remains above 50,000 lines, its exact owned production
  and UI total is also a non-growth debt ceiling. Ratchet that ceiling after
  every measured reduction; once it reaches 50,000, the final target is hard.
- Each extraction preserves behavior, adds focused unit tests, and keeps the
  existing surface verification green.
- Domain modules own bounded data transformations. The gateway entrypoint
  should eventually contain composition, startup, and route registration only.
- Every owned file is classified exactly once. Coverage and line-count scope
  use the same inventory, and every changed surface must preserve its public
  behavior and non-regress its production-only coverage before a reduction is
  credited.
- Source paths follow `surface/domain/role` ownership. File names state a
  single domain noun and role such as `voice-session-store`, `voice-turn-routes`,
  or `provider-vertex-adapter`; catch-all `utils`, `common`, and undifferentiated
  `lib` additions are rejected.
- The restructuring passes four recorded review rounds: inventory, gateway
  consolidation, client-surface consolidation, and independent acceptance.

## First Milestone

The first extraction established the automated source-size policy. The current
program now follows the target structure and staged savings plan in
[`target-source-architecture.md`](target-source-architecture.md).
