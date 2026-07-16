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

At `f70977d2`, the existing classifier reports 95,208 owned production and UI
lines. The final acceptance target is at most 50,000 lines. Reaching it requires
evidence-backed consolidation and deduplication across Android, browser,
gateway, and website code—not minification, moving owned behavior into
dependencies, relabeling source as generated, or deleting coverage.

The 2,000-line ceiling is a hard emergency boundary: a larger file cannot be
reviewed reliably as one responsibility and routinely exhausts a model's useful
context with unrelated behavior. It does not bless 1,999-line modules. New
files above 1,000 lines require explicit review, composition entrypoints must
converge to at most 500 lines, and each extraction should choose the smallest
domain boundary that can be tested independently.

Every tracked owned file must be classified exactly once as executable, UI,
operational tooling, migration/schema, generated/vendor, test, or fixture.
Executable and UI categories count toward the 50,000-line acceptance total.
The inventory must recognize all owned implementation extensions, reject
unknown or multiply classified files, count tracked files only, and prevent
generated/vendor status from being asserted without provenance. Operational,
migration, fixture, and test categories remain visible as separate totals so
code cannot disappear from the report.

While the tree is above the final target, 95,208 lines is the repository-wide
non-growth debt ceiling as well as the per-file ceilings. A bounded new module
may be legitimate only when the same change keeps the total at or below the
recorded ceiling. Lower the total ceiling after every measured reduction. When
the ceiling reaches 50,000, 50,000 becomes the permanent hard maximum. This
prevents a collection of individually bounded files from hiding total growth.
Test and smoke source is measured independently and may not exceed 2x owned
production source. The ratio gate must not be satisfied by deleting meaningful
failure-path, adversarial, or integration coverage.
Coverage is measured per surface over eligible executable production source;
test/smoke files and UI markup/styles cannot inflate the reported percentage.

## Naming and discoverability

The target path grammar is `surface/domain/role-file`. Directories name product
domains; files name one domain noun plus one role: `routes`, `service`, `store`,
`policy`, `schema`, `adapter`, `controller`, `view`, or `composition`. A model
must be able to select the likely file from the path without opening every
neighbor. New catch-all `utils`, `helpers`, `common`, `misc`, and flat `lib`
files are not accepted. Domain-local tests mirror the production name.

The complete budgets, directory trees, migration waves, and savings ledger are
recorded in [`target-source-architecture.md`](target-source-architecture.md).

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
