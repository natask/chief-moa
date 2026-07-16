# Target Source Architecture

## Acceptance contract

The final owned production and UI total is at most 50,000 physical lines. The
count includes executable application code and behavior-bearing UI markup and
styles. It excludes tests, fixtures, operational tooling, migrations, and
generated/vendor files only after each tracked file has exactly one audited
classification. Excluded categories remain reported, and generated/vendor
files require reproducible provenance.

No reduction is credited when it comes from minification, compressed formatting,
moving owned behavior into a dependency or generated file, deleting meaningful
tests, weakening coverage scope, or silently dropping a public behavior. Each
surface retains its existing API/runtime smoke inventory and production-only
coverage floor; changed domains add focused 90% line, branch, and function or
method gates.

## Audited baseline and target budgets

The clean `f70977d2` audit reports 95,208 lines in 221 files under the current
classifier. The audit found 84,566 executable lines, 4,473 comment lines, and
6,169 blank lines. Physical lines remain the acceptance measure so formatting
cannot make complex behavior disappear from review.

| Surface | Current lines | Target budget | Required reduction |
| --- | ---: | ---: | ---: |
| Gateway | 57,384 | 24,000 | 33,384 |
| Browser extension | 15,424 | 9,000 | 6,424 |
| Android | 14,944 | 10,000 | 4,944 |
| Website | 4,128 | 3,000 | 1,128 |
| Apple surfaces | 1,335 | 1,335 | 0 |
| Windows portable core | 1,042 | 1,042 | 0 |
| LiveKit worker | 951 | 951 | 0 |
| **Total** | **95,208** | **49,328** | **45,880** |

The 672-line margin is deliberate. Later exact classification may move files
between reported categories, and feature-parity repairs may add bounded code.
No surface may spend another surface's budget without updating this ledger with
measured evidence.

Until the final target is reached, 95,208 is also a repository-wide non-growth
debt ceiling. It ratchets down after each accepted reduction so new bounded
files cannot recreate removed complexity elsewhere. When the ceiling reaches
50,000, the final target replaces the migration ceiling permanently.

## Savings ledger

These are target architecture pools, not reductions already achieved. A review
credits only the measured before/after delta after native verification.

Every gateway file and each line of `gateway/server.js` is assigned to exactly
one pool below; the five current gateway values reconcile to 57,384 lines. A
migration may move code between pools, but only a reduction in their combined
measured total counts as savings.

| Pool | Current evidence | Target | Planned saving | Consolidation mechanism |
| --- | ---: | ---: | ---: | --- |
| Gateway voice and media | 23,349 | 9,000 | 14,349 | One staged turn pipeline, provider drivers, shared Google auth/instructions, event-derived diagnosis, and one transactional draft/media persistence contract. |
| Gateway work and agents | 9,592 | 4,000 | 5,592 | One intent/work aggregate; work history, graph, runs, workers, and broker views become projections or compatibility adapters rather than parallel authorities. |
| Gateway profile and product domains | 8,130 | 4,000 | 4,130 | Shared versioned storage and schema validation for profile, companion, account, release, OTA, and UI-spec domains without merging their authority boundaries. |
| Gateway context and protocol | 5,333 | 3,000 | 2,333 | One admitted context artifact and reducer; remove repeated legacy context assembly only after compatibility migration evidence. |
| Gateway infrastructure, browser, and routes | 10,980 | 4,000 | 6,980 | Declarative route/auth/body composition, one durable adapter family, thin entrypoint, and removal of duplicated local sanitizers. |
| Browser orchestration and runtime | 15,424 | 9,000 | 6,424 | One background transport/session coordinator, bounded content controllers, shared schemas, and development-only reload behavior outside the shipped runtime. |
| Android application | 14,944 | 10,000 | 4,944 | Thin service/activity shells over shared voice, overlay, approval, action, and receipt controllers; no platform authority moves to the gateway. |
| Website application | 4,128 | 3,000 | 1,128 | Reusable pet-studio state/rendering components and shared bounded proxy handling. |
| **Total** | **95,208** | **49,328** | **45,880** | |

Extraction alone does not earn a saving. If code merely moves from an entrypoint
to a new module, the ledger is unchanged. Compatibility code is removed only
after stored-state migration, client-version support, and route-use evidence
show that public feature parity is preserved.

## Target directory trees

Names below are target ownership boundaries. Migration may reuse an existing
well-scoped file rather than creating every illustrated file.

```text
gateway/
  src/
    composition/gateway-composition.js
    http/gateway-router.js
    auth/gateway-auth-policy.js
    voice/
      session/voice-session-service.js
      session/voice-session-store.js
      turn/voice-turn-service.js
      turn/voice-turn-routes.js
      draft/voice-draft-service.js
      provider/provider-registry.js
      provider/provider-vertex-adapter.js
      provider/provider-openai-adapter.js
      diagnosis/voice-diagnosis-projector.js
    work/
      intent/intent-service.js
      intent/intent-store.js
      run/run-service.js
      run/run-routes.js
      worker/worker-service.js
      artifact/artifact-store.js
    context/
      admission/context-admission-policy.js
      artifact/context-artifact-service.js
      thread/thread-store.js
    profile/
      profile-service.js
      profile-store.js
      profile-routes.js
    companion/
      companion-service.js
      companion-schema.js
      companion-routes.js
    browser/
      browser-turn-service.js
      browser-task-routes.js
    storage/
      event-store.js
      postgres-event-adapter.js
      file-event-adapter.js
```

```text
browser_extension/extension/
  background/
    background-composition.js
    gateway-client.js
    voice-session-controller.js
    browser-task-controller.js
  content/
    content-composition.js
    overlay-view.js
    voice-turn-controller.js
    note-capture-controller.js
    page-action-controller.js
  shared/
    aggie-message-schema.js
    profile-schema.js
    storage-adapter.js
```

```text
android_app/app/src/main/java/ai/moa/assistant/
  composition/
    MoaApplicationComposition.java
  overlay/
    OverlayService.java
    OverlayController.java
    OverlayView.java
  voice/
    VoiceSessionController.java
    VoiceCaptureAdapter.java
    VoicePlaybackAdapter.java
  action/
    ActionApprovalPolicy.java
    ActionExecutor.java
    ActionReceiptStore.java
  gateway/
    GatewayClient.java
    AggieMessageSchema.java
  settings/
    SettingsActivity.java
    SettingsStore.java
```

```text
website/
  public/pets/
    pet-studio-view.js
    pet-studio-controller.js
    pet-library-view.js
  functions/api/
    gateway-proxy.js
    voice-session-routes.js
    profile-routes.js
```

## Naming grammar and size budgets

A production path follows `surface/domain/role-file`. The directory is a stable
product/domain noun. A file has one concrete noun and one role suffix:

- `*-routes`: transport matching and response mapping only;
- `*-service`: domain orchestration;
- `*-store`: persistence contract and serialization;
- `*-policy`: pure decisions and validation;
- `*-schema`: bounded wire or stored representation;
- `*-adapter`: provider or platform integration;
- `*-controller`: lifecycle coordination for one UI/runtime boundary;
- `*-view`: presentation only;
- `*-composition`: dependency construction and startup only.

Avoid `utils`, `helpers`, `common`, `misc`, `manager`, and new flat `lib` files.
Those names do not tell an agent which behavior they own. Tests mirror source
names inside the surface's established test root.

The hard file ceiling remains 2,000 physical lines while legacy debt is paid
down. New files above 1,000 lines require explicit design review. Composition,
route, and UI-controller entrypoints converge to 500 lines or fewer. A file
that approaches the hard ceiling must not absorb a second domain merely to
avoid creating a well-named neighbor.

## Migration waves

1. **Inventory and lock.** Replace heuristic classification with an exhaustive
   tracked-file inventory, report every category and surface, lower all debt
   ceilings to exact baselines, record route/smoke/coverage parity inventories,
   and reject unknown files.
2. **Gateway authority consolidation.** Establish shared durability contracts;
   converge voice/media, intent/work, context, and profile reads behind bounded
   services; keep old and new stored forms readable; then shrink route and
   composition code. Do not remove a compatibility write/read until backfill,
   restore, and rollback evidence exists.
3. **Client surface consolidation.** Split browser and Android lifecycle shells
   along their local authority boundaries, unify duplicated local schemas and
   state controllers, and simplify the website studio. Run native coverage,
   build, and runtime smokes after each independently reviewable slice.
4. **Independent acceptance.** Re-audit every tracked file and name, confirm the
   total is at most 50,000, compare public route and behavior inventories, run
   production-only coverage for every surface, and reject any result produced
   by exclusion drift, test deletion, minification, or dependency offloading.

Each wave gets an architecture review, duplication/dead-code review, coverage
review, and feature-parity review before its ledger delta becomes permanent.
