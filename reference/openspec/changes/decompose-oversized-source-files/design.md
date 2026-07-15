# Design

## Current Hotspots

The initial tracked-source audit found these files above the 2,000-line limit:

| File | Baseline lines | Intended boundary |
| --- | ---: | --- |
| `gateway/server.js` | 16,610 | composition and route registration |
| `gateway/lib/voice-drafts.js` | 5,950 | durable draft state machine and persistence |
| `browser_extension/extension/background.js` | 5,663 | background orchestration |
| `browser_extension/extension/content.js` | 4,614 | content-script composition |
| `android_app/app/src/main/java/ai/moa/assistant/OverlayService.java` | 4,094 | Android service lifecycle |
| `gateway/lib/voice-providers.js` | 4,049 | provider registry and adapters |
| `gateway/lib/voice-session-server.js` | 2,279 | voice-session transport |
| `website/public/pets/index.html` | 2,244 | pet-library markup, styling, and behavior |
| `gateway/lib/work-history.js` | 2,032 | work-history domain and persistence |

Line counts are audit evidence, not a quality score. Generated assets, lock
files, documentation, tests, and smoke fixtures are not governed by the
production-source limit.

## Enforcement

`scripts/source-size-policy.js` reads tracked files from Git. A production
source file fails when it exceeds 2,000 lines unless it is in the legacy-debt
map. A debt file fails if it grows beyond its recorded ceiling. Lowering a
ceiling after an extraction makes the improvement permanent.

The initial pre-classifier cross-surface baseline was 75,802 production lines
in the working tree, including non-ignored untracked source files. The first
reviewed simplification milestone is 60,000 owned production lines. The 10,000
line ultimate goal remains explicit, but reaching it requires evidence-backed
scope reduction and deduplication across Android, browser, and gateway—not
minification or moving owned behavior into dependencies.

The production total is a trend metric rather than a hard ceiling: a bounded
new module may legitimately increase it. Per-file ceilings remain the hard
ratchet, so consolidation cannot hide growth in an already oversized file.
Test and smoke source is measured independently and may not exceed 2x owned
production source. The ratio gate must not be satisfied by deleting meaningful
failure-path, adversarial, or integration coverage.
Coverage is measured per surface over eligible executable production source;
test/smoke files and UI markup/styles cannot inflate the reported percentage.

## Extraction Order

1. Pure input normalization and trust-boundary validators.
2. Storage adapters and record serialization.
3. Domain services with injected dependencies.
4. HTTP route modules.
5. Startup/composition cleanup.

For `gateway/server.js`, use domain slices rather than arbitrary line chunks:
browser evidence, broker/work history, companions, profiles, agent execution,
voice diagnosis, cascaded voice, context/thread history, device tools, model
providers, and finally route registration.

Every slice requires focused unit tests plus `cd gateway && npm run check`.
Cross-surface slices additionally run their native verification command.

New files above 1,000 executable lines require explicit review, 2,000 remains
the hard maximum, and composition entrypoints should converge below 500 lines.
