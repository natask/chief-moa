# Design

## Current Hotspots

The initial tracked-source audit found these files above the 2,000-line limit:

| File | Baseline lines | Intended boundary |
| --- | ---: | --- |
| `gateway/server.js` | 15,923 | composition and route registration |
| `browser_extension/extension/background.js` | 4,489 | background orchestration |
| `gateway/lib/voice-providers.js` | 4,016 | provider registry and adapters |
| `browser_extension/extension/content.js` | 3,704 | content-script composition |
| `android_app/app/src/main/java/ai/moa/assistant/OverlayService.java` | 3,659 | Android service lifecycle |
| `gateway/lib/voice-session-server.js` | 2,047 | voice-session transport |

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
reviewed simplification milestone is 60,000 owned production lines; a 10,000
line repo would require deleting most Android, browser, and gateway behavior and
is not adopted without an explicit product-scope rewrite.

The total-production ceiling ratchets downward separately from that milestone.
Test and smoke source is measured independently but has no hard ratio cap.
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
