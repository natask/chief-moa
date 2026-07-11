# Chief Moa reduction system map

## Reduction boundary

The frozen classifier reports 63,576 semantic production LOC across the repository at baseline `516753d`. The detailed audits account for 32,542 gateway code lines and 23,115 nonblank client runtime lines; their counting methods differ slightly, so portfolio percentages must always use the same frozen repository classifier before and after a change. Tests, fixtures, documentation, configuration, and generated output are reported separately and never count as savings.

The product is not “90k lines of one app.” It is three authority domains joined by protocols:

```text
Android phone                         Browser extension
UI, capture, approvals,              UI, page evidence, local allowlist,
phone actions, receipts              CDP/page actions, browser receipts
          \                              /
           HTTP + WebSocket + bounded proposals
                         |
                    Moa gateway
 auth, profiles, model/voice routing, durable conversation/run/event state,
 provider credentials, harness and worker coordination, served customization
                         |
       execution workers + external providers/APIs + Postgres/blob storage
```

Reduction must preserve that authority split. Moving phone/browser execution into the gateway, moving provider secrets into clients, or treating model output as executable would reduce lines by deleting the product's safety boundary and is forbidden.

## Canonical product journeys

These journeys are the behavior-level units. Internal modules may be deleted or merged when the journey outcome and evidence scorecard remain equal or better.

| Journey | Canonical flow | Durable evidence | Local authority |
|---|---|---|---|
| Text turn | client input → authenticated gateway turn → profile/context/model/tools → visible reply | session, branch, turn, profile version, provider/model result | client preserves draft and renders terminal state |
| Spoken turn | gesture/capture → WS audio/commit → STT → reason/tools → hosted TTS/audio/done | exact final transcript and source, partials, phase diagnostics, reply/modality/TTS result | client owns capture, playback, stop and visible fallback |
| Interrupted/resumed turn | stop/drop/barge-in → incomplete canonical turn → later context pack on either client | incomplete marker, partial transcript/text, stable session/branch relation | client can stop promptly; gateway retains what occurred |
| Phone action | model/gateway proposal → Android validation/policy → approval if needed → local executor | proposal, decision, approval and receipt relations | Android alone executes phone action |
| Browser page action | bounded proposal/task → extension allowlist/ownership → local tweak or CDP step | task/action/status/receipt/history | extension alone executes page/browser action |
| Profile/customization | user intent/tool → sanitized versioned profile or companion/UI spec → next-turn snapshot | append-only version/history and effective scope | clients render; gateway owns canonical profile/spec |
| Agent work | intent → broker/work task → harness/worker claim → status/cancel/result | run events, context pack, task/control/deployment links | gateway coordinates; execution machine performs work |
| Failure diagnosis | injected or real failure → conservative phase → visible honest terminal state | normalized phase, evidence refs, retained turn/result | no silent terminal failure or false success |

## Surface ownership and desired module boundaries

### Android

The desired Android runtime has four narrow layers:

1. **Surface:** orb and one-current-intent overlay; full app for history, settings, run detail, updates and deep approval review.
2. **Interaction reducer:** one canonical gesture and voice/turn state model, exhaustively tested independently of Android callbacks.
3. **Adapters:** gateway HTTP/WS, mic/audio, permissions, OTA and lifecycle callbacks.
4. **Trusted execution:** proposal validation, approval policy, phone-local action execution and receipts.

Current duplication crosses these layers. `OverlayService.java` owns UI, gesture callbacks, voice state, playback fallback, polling and actions; `MainActivity.java` repeats control/status UI; multiple voice controllers and gesture grammars coexist. The intended end-state keeps adapters distinct for platform reasons but has one state contract and one owner for each UI responsibility.

### Browser extension

The desired extension has five bounded modules:

1. **One command surface contract** with optional views that render the same state core.
2. **One interaction/turn reducer** shared by overlay and any retained extension page.
3. **Background gateway adapter** as the sole token-bearing network authority.
4. **Evidence/action executor** for bounded page context, tweak allowlist and CDP task ownership.
5. **Declarative UI renderer** using one sanitizer/component vocabulary.

Today `background.js` and `content.js` are multi-runtime monoliths; content duplicates the UI-spec sanitizer and stop matcher, options bypasses the background adapter, overlay and side panel duplicate voice/turn lifecycles, and legacy/experimental gesture grammars coexist.

### Gateway

The desired gateway has six cohesive boundaries:

1. **Small transport/router:** route table, authentication, body limits and error mapping.
2. **Canonical turn application service:** text/browser/voice orchestration around context, profile tools, action proposals, persistence and terminal results.
3. **Provider codecs:** provider-specific authentication/encoding/stream parsing behind one tool-loop and one voice stage contract.
4. **Canonical repositories/events:** Postgres plus blob storage remotely; one generic file adapter locally; stable repository contracts.
5. **Work runtime:** one explicit vocabulary for task, run, claim, control, result and deployment projections.
6. **Presentation/catalog services:** profiles, companion/UI specs and served control surfaces without parallel compatibility resources.

Today `server.js` contains 13,680 code lines and about 100 route predicates. It hosts several turn pipelines, bespoke file stores and lifecycle bridges. `voice-providers.js` duplicates tool-loop and Live-provider state. Work graph, work history, agent runs, worker pull and broker events overlap without one canonical vocabulary.

## Protocols that are product contracts

| Boundary | Preserve | May consolidate internally |
|---|---|---|
| Client ↔ gateway HTTP | authentication, routes during migration, bounded bodies, response/action/error semantics | route dispatch, request helpers, turn orchestration |
| Client ↔ gateway WS | ready/partial/final/audio/progress/error/done ordering, stop/close, exact transcript provenance | provider mapping, reducers, buffering implementation |
| Gateway ↔ providers | timeout/abort, tool-call semantics, streaming deltas, honest fallback | one normalized tool-loop; provider codecs |
| Gateway ↔ stores | stable IDs/relations, idempotency, ordering, backup/restore, old/new compatibility | repository implementations and projections |
| Gateway ↔ worker | claim/lease/heartbeat/cancel/result and replay-safe events | overlapping work stores and adapters |
| Proposal ↔ client executor | bounded schema, local validation, approval and receipt | duplicate parsers/renderers, transport wrappers |

Compatibility adapters must be named, instrumented, time-bounded and removable. A permanent adapter without a retirement condition is a second product surface.

## State inventory and intended authority

| State | Current forms | Intended end-state |
|---|---|---|
| conversation/session/branch/turn | conversation JSON, chat/voice files, JSONL, relational schema, thread store | canonical repository plus event record; blob refs for audio |
| profile/customization | profile store/history, companion and pet catalogs, UI-spec files | versioned scoped profile/customization repository |
| browser work/action | legacy browser task files, browser-agent-loop store, tool requests | one task/action lifecycle with typed executor projection |
| agent/work lifecycle | agent-run files, broker events/context packs, work graph, work history, worker pull | canonical task/run/event vocabulary with indexed projections |
| diagnostics | provider event JSONL, turn records, health/status summaries | normalized phase events attached to canonical turn/run |
| accounts/credentials | encrypted account-connection store plus notification bridge | credential boundary retained; notifications emitted into canonical tool/action lifecycle |
| local client preferences | Android prefs, Chrome storage and experimental flags | local-only presentation/permission preferences; gateway profile for cross-device behavior |

Remote mode already requires `DATABASE_URL`; production should not maintain a bespoke file implementation per feature. Local development still needs a dependency-light store, but it should implement the same repository contracts through one generic adapter. Migration tools are tools, not runtime code.

## Compatibility and duplication map

| Compatibility layer | Evidence | End-state / decision needed |
|---|---|---|
| `relational-store.js` | 743 LOC, absent from running-server imports; used by import tool/tests | reclassify out of runtime artifact now; delete only after restore/import replacement is proven |
| browser `/v1/browser/tasks` and `/v1/browser/agent-tasks` | two create/list/claim/update systems | canonical agent-task API; telemetry-backed adapter then delete legacy routes/store |
| companion and pet resources | parallel create/preview/apply plus converters | one versioned customization resource; product names may remain presentation aliases |
| OpenAI/Vertex streaming/non-streaming tool loops | four round paths with duplicated state machine | one state machine, provider codecs |
| cascaded and native Live providers | primary cascaded plus switchable legacy Live; specs still require provider independence | retain until explicit provider/fallback product decision and quality/cost capture |
| browser overlay and side panel | two voice/turn renderers | share state core first; then choose one surface only if capability/usage evidence supports it |
| legacy and voice-first gestures | branches on both clients | graduate one grammar only after cross-platform trace/canary evidence |
| Android platform recognition/local TTS and streaming voice | parallel capture/delivery legs | one orchestration model; retire legs only with degraded-mode product decision |
| overlay and full-app detail | duplicated status/settings/history affordances | thin overlay, full control center, preserving immediate approvals/current intent |

## Intended end-state

The goal is not the fewest files. It is one implementation per semantic responsibility:

- one cross-platform gesture contract, implemented by small platform adapters;
- one client turn-state contract per platform, with multiple views only as renderers;
- one gateway turn application service used by text, browser and voice transports;
- one model tool-loop with provider codecs;
- one canonical remote state/event model and one conforming local adapter;
- one task/action lifecycle, specialized by executor type rather than copied stores;
- one customization vocabulary;
- compatibility code carries an owner, observed caller, expiry condition and rollback plan.

The architecture-preserving target from the audits is roughly 4,580–8,603 production LOC before major storage/turn consolidation, and approximately 8,000–15,000 after staged consolidation and approved compatibility retirement. These ranges overlap and must not be summed blindly; each wave re-baselines with the frozen classifier.
