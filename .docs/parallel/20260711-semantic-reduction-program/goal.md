# Semantic Reduction Program

## Outcome

Materially reduce Chief Moa's production implementation while preserving or improving agent behavior, reliability, latency, resource use, security boundaries, and maintainability.

## Baseline

- Comparison base: `516753d437ffc3b31cfd9d2e110a986800f5436a`.
- Count source with one checked-in reproducible command before accepting edits.
- Separate production, test/fixture, generated, configuration, and documentation lines. Never claim a reduction by deleting coverage or reformatting statements.

## Required evidence before deletion

- Highest-order deterministic journeys for phone/browser -> gateway -> response/action proposal -> receipt/history.
- Runtime captures for representative voice, text, action, interruption, profile, and failure-diagnosis paths, sanitized of secrets and sensitive user content.
- A behavior scorecard: outputs/actions, persistence, failure phase, latency, memory/CPU where measurable, and test stability.
- Coverage and duplication/dead-code reports mapped to concrete modules.

## Acceptance

- Material net reduction in production semantic LOC; tests and fixtures are reported separately.
- Existing tests plus the new behavior gates pass before and after.
- No behavior score regresses without explicit user approval.
- Correctness, trust/security, performance/resource, no-gaming, and tech-debt audits return PASS.
- Every accepted unit is committed conventionally and has a preview/release artifact or an explicit promotion blocker.

## Non-goals

- No minification, statement packing, generated-source substitution, dependency dumping, or test deletion to game LOC.
- No product-contract or trust-boundary weakening.
- No active deployment, restart, browser reload, recording interruption, or production-data mutation during research and implementation lanes.

## Initial lanes

1. Behavior and test topology: define highest-order journeys, capture strategy, current coverage gaps, and reproducible baseline commands.
2. Gateway architecture: find dead paths, duplicated providers/routers/storage logic, oversized modules, and runtime/performance evidence needed before consolidation.
3. Client architecture: find duplicated browser/Android state machines, generated UI/runtime overlap, and end-to-end gates needed before consolidation.

## Full gate

- `cd gateway && npm run check`
- `cd browser_extension && npm run verify && npm run smoke`
- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug test`
- Relevant OpenSpec strict validations.
