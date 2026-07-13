# Intent portfolio anti-omission audit

Date: 2026-07-10

Lane: `agent/intent-portfolio-audit`
Verdict: **BLOCK — the active seven-program roadmap is a useful spine, but it
does not yet materialize the full durable intent portfolio.**

This is a read-only goal-correctness and anti-gaming audit. No product code,
provider call, paid benchmark, live deployment, or production mutation was
performed. A checked OpenSpec task is treated as an implementation claim until
its current code, tests, artifact, and deployment evidence are independently
re-run.

## Authoritative sources inspected

- User intent capture:
  `/Users/natnaelkahssay/.codex/attachments/a93d40a3-eead-4ba7-b632-e452df8b89ba/pasted-text.txt`
- Active portfolio goal, stack map, claims ledger, and merge ledger under
  `scratch/agent-loop/runs/20260710-moa-portfolio-program/`
- `README.md`, `ARCHITECTURE.md`, `AGENT_WORKFLOW.md`, and current git history
  through `e6cc948`
- Every `proposal.md` and `tasks.md` under `reference/openspec/changes/`, with
  focused inspection of the changes named below

## Finding

The active goal's P0-P6 sequence accurately covers voice, browser
customization, context, deployment control, native surfaces, and companions.
It silently compresses or omits other user intents that already have durable
OpenSpec changes: the common Aggie surface protocol, hosted product and tenant
identity, durable event/projection/export substrate, per-surface skills,
remaining streaming voice work, telemetry/observability, payments and
entitlements, product analytics, and operational release evidence. Those are
not optional implementation details of P0-P6. Several are independent programs
with different authority, storage, privacy, and acceptance boundaries.

## Evidence-linked intent matrix

Status labels: **verified** means current deterministic evidence is recorded in
the run ledger; **claimed** means task files say complete but this audit did not
re-run the gate; **partial** means explicit unfinished tasks or missing
acceptance evidence exist; **absent** means no implementation contract/evidence
was found in the active run.

| Intent | Authoritative source | Current status / evidence | Dependencies | Parallel? | Proposed full session-manager | Missing contract or gates | Omission risk |
|---|---|---|---|---|---|---|---|
| Voice reliability, audible fallback, phase diagnosis | user capture; `provider-agnostic-voice-agent-runtime`; P1 contract/claims | Wave 1 deterministic diagnostics **verified**: gateway 155 pass/1 skip; live provider and phone audio unmeasured | profile/event identity; preview safety for promotion | yes, provider QA and client QA after deterministic base | **SM-VOICE-RELIABILITY** with gateway, Android, browser, provider-eval, audit rings | real-device audio, live-provider failure canaries, retained replay consent, SLO threshold, promotion evidence | high if P1 is called complete from deterministic tests alone |
| Same-conversation voice/language/style switching, spoken tool acknowledgement, sampling | user capture; `voice-delivery-controls`; `streaming-cascaded-voice`; provider-agnostic voice specs | profile/sampler architecture and browser sampler **verified deterministically**; streaming change still has 28 unchecked tasks | ordered tool-round semantics; streaming TTS; client multi-frame playback | partly; gateway streaming, Android, browser, LiveKit are disjoint, final E2E serial | **SM-STREAMING-VOICE** | actual next-segment semantics, multi-frame interruption, circuit breaker, real launch demo | critical: Wave 1 evidence is not completion of streaming voice |
| Browser page redesign through safe declarative customization | user capture; `extension-ui-self-extension`; `thin-client-gateway-architecture` | P2 contract exists; implementation candidate is under repair; 7 + 4 relevant tasks remain unchecked | account identity, typed renderer, local authority, package hash | yes: gateway spec, runtime renderer, sandbox research, Chrome QA; integrate serially | **SM-BROWSER-CUSTOMIZATION** | real Chrome engine-to-DOM roundtrip, unchanged package hash, per-user isolation, rollback/receipt, sandbox CSP/userScripts gates | high; current P2 candidate previously failed adversarial audit |
| Durable context recall without thinking about sessions | user capture; `context-thread-management`; P3 | thread/context tasks mostly claimed complete; client switcher/incognito receipt and deploy remain open; P3 has no run contract | event substrate, privacy/retention, retrieval corpus | yes: storage/invariants, retrieval eval, privacy audit, client UX | **SM-CONTEXT-RETRIEVAL** | representative recall/precision corpus, latency/token budgets, deletion/incognito proof, cache identity, cross-device E2E | high: checked backend tasks do not prove the desired invisible UX or relevance |
| Agent edits/tests/previews/deploys itself with rollback | user capture; P4; `remote-hosted-gateway`; deployment rules | substantial VPS/worker machinery claimed; P4 has no dedicated manager packet/evidence in active run | identity/scopes, durable jobs, artifact provenance, event receipts | research/contracts parallel; apply and runtime QA serial | **SM-DEVELOPMENT-CONTROL-PLANE** | proposal/review/claim/apply state machine, least-privilege worker scopes, preview isolation, immutable receipts, rollback drill, no raw shell to model | critical authority boundary |
| Self-hostable, separable gateway/agent/deployment services | user capture; `remote-hosted-gateway`; `self-hostable-event-substrate`; architecture | partial; remote change has 36 unchecked tasks and substrate has 21 | identity modes, Postgres projections, worker leases, backup/restore | yes by service ownership; migration/integration serial | **SM-SELF-HOSTED-PLATFORM** | service split triggers, install/upgrade journey, export/import, projection rebuild, restore proof, version compatibility | high; “VPS exists” is not self-hostable product completion |
| Common cross-surface Aggie protocol/backend adapter | `define-aggie-compatible-surface` | 17 unchecked tasks; only naming/boundary baseline claimed | stable session/event envelope, voice and broker APIs | yes: facade, echo adapter, browser adapter, contract tests | **SM-AGGIE-SURFACE-PROTOCOL** | exact protocol/versioning, auth, echo oracle, subscriber ordering, compatibility matrix | critical omission: absent from P0-P6 as an owned program despite native/client dependence |
| Native macOS, then iOS, then Windows agents with native UI/local authority | user capture; P5; architecture | intent only; active claims ledger rates architecture confidence 20/100 (not measured) | Aggie protocol, identity, receipts, update/signing contract | macOS protocol/UI research may start; platforms can implement in parallel only after shared protocol freezes | **SM-NATIVE-SURFACES** with child managers per OS | platform ownership maps, accessibility, permissions, signing/notarization, updater/rollback, action receipts, device QA | high if mock shells substitute for native acceptance |
| Companion/pet customizability, creation, sharing, provenance | user capture; P6; companion catalog/pet changes | many tasks claimed complete; one deployment task open; P6 sharing/moderation contract absent | asset store, profile versioning, native renderers, identity | yes: manifest/provenance, renderer, catalog/sharing, moderation | **SM-COMPANION-ECOSYSTEM** | signed portable package, license/provenance, moderation, compatibility, sharing identity, rollback across surfaces | high: local pet studio is not catalog/sharing completion |
| Per-surface tool/skill capabilities across mobile/browser/desktop | user capture (“tool calls of varying types”, different services); `per-surface-agent-skills` | 20 unchecked tasks | Aggie surface identity, proposal/action/receipt boundary | yes by surface and capability ownership | **SM-SURFACE-SKILLS** | capability schema, policy/approval, timeout/idempotency, cross-device routing, hostile page/screen tests, receipt coverage | critical omission from active portfolio naming |
| Frontend + backend observability and portable telemetry | user's later explicit stack; `product-platform-stack.md`; stack research | architecture target only; no verified OTLP exporter/backend/RUM deployment; vendor selection unmeasured | semantic IDs, data classification, consent/retention | yes: semantic envelope, gateway export seam, Android crash/release, extension error/RUM, vendor evaluation | **SM-TELEMETRY-OBSERVABILITY** | owner/data taxonomy, redaction/cardinality/cost budgets, exporter-failure isolation, scrubbed canaries, dated official vendor comparison, alert/SLO verification | critical explicit intent omitted from P0-P6 execution sequence |
| Canonical database, durability, projections, export/import, retention | user's later stack; `postgres-work-graph-artifact-store`; `self-hostable-event-substrate` | Postgres-capable schema/event mirroring claimed; projections, rebuild, export/import, auth modes and sync incomplete | tenant identity, data classification, migration compatibility | yes: schema/projections, retention, archive, restore; migration cutover serial | **SM-DATA-PLATFORM** | datum ownership matrix, RLS/tenant tests, retention/deletion/export, PITR/restore objectives, blob encryption, backward-compatible migration | critical; schema presence is not production durability |
| Production identity, tenant isolation, device/session scopes, secret lifecycle | hosted product specs; architecture trust boundary; stack research | single-token/single-user assumptions; multi-tenant safety unproven | canonical account/device model; database/RLS | identity design precedes most hosted writes; implementation lanes parallel after contract | **SM-IDENTITY-SECURITY** | threat model, token issuance/rotation/revocation, device binding, RLS, origin/replay protection, admin/audit access, abuse tests | critical; P2 already exposed cross-user storage risk |
| Full hosted product/frontends/backend readiness | `production-grade-hosted-product` (32 unchecked tasks); `remote-hosted-gateway` | partial infrastructure; no active-run whole-product contract or verified release | identity, data, telemetry, operations | yes by web/gateway/account/onboarding; release serial | **SM-HOSTED-PRODUCT** | onboarding, account recovery, support/admin, accessibility, rate/abuse limits, privacy/retention, SLOs and preview | high; active roadmap otherwise ends before a usable hosted product |
| Payments, metering, entitlements, budgets, reconciliation | user's explicit stack; `product-platform-stack.md`; stack research | **absent/unmeasured**; safety boundary only | identity, immutable event/data ledger, product packaging | provider research and ledger contract parallel; authority integration after foundations | **SM-BILLING-ENTITLEMENTS** | business/pricing decision escalation, usage event schema, provider adapter, signed webhook/replay, refunds/disputes/dunning, test clock, reconciliation, spend caps | critical explicit omission; do not infer authorization to charge or choose provider |
| Privacy-bounded product analytics | user's stack and stack research | target only; no taxonomy/consent/funnel evidence | telemetry envelope, identity/privacy, deletion propagation | yes after semantic envelope freezes | **SM-PRODUCT-ANALYTICS** | event taxonomy, consent, no-content leakage, deletion, experiment policy, activation/reliability funnels | medium-high; debug telemetry cannot silently become analytics |
| Release operations: CI, artifacts, previews, rollback, backup/restore, drain/resume | user autonomous deployment intent; deployment contract; run ledger | Wave 1 artifacts exist; promotion correctly gated; no current isolated gateway preview/restore/drain evidence | every deployable lane | artifact builds parallel; promotion and post-apply smoke serial per target | **SM-RELEASE-OPERATIONS** | stable preview environments, provenance/SBOM, rollback time, restore drill, active-work drain, compatibility matrix, post-apply smoke | critical; “tests green” must not imply safely deployed |
| Open-source/provenance strategy and reuse of external projects | user wants lessons from Tweaks; `open-source-engineering-strategy`; P6 provenance boundary | planning change exists; no evidence in active run of license/provenance decision for reused code | legal provenance, architecture boundary | yes, read-only research can precede implementation | **SM-PROVENANCE-OSS** | license inventory, clean-room/reuse rules, attribution, dependency policy, release posture | high if “inspired by” becomes silent code copying |

## Proposed session-manager DAG

This is a concurrency plan, not authorization to deploy, select a paid vendor,
incur model/provider spend, or implement unresolved business decisions.

```text
Wave A — foundations (parallel research/contracts; 6 managers max)
  IDENTITY-SECURITY ─────────────┐
  DATA-PLATFORM ───────────────┐ │
  AGGIE-SURFACE-PROTOCOL ──────┼─┼──────────────┐
  TELEMETRY-OBSERVABILITY ─────┼─┼───────────┐  │
  PROVENANCE-OSS ──────────────┘ │           │  │
  RELEASE-OPERATIONS ────────────┴───────┐   │  │
                                          │   │  │
Wave B — product capabilities (parallel)  │   │  │
  STREAMING-VOICE ◄───────────────────────┘   │  │
  BROWSER-CUSTOMIZATION ◄── identity/data ────┘  │
  CONTEXT-RETRIEVAL ◄────── data/privacy ────────┤
  SURFACE-SKILLS ◄───────── Aggie/identity ──────┘
  SELF-HOSTED-PLATFORM ◄─── data/identity/release

Wave C — surfaces and commercial/product layer (parallel after foundations)
  NATIVE-SURFACES ◄──────── Aggie + skills + release
  COMPANION-ECOSYSTEM ◄──── identity + data + provenance
  HOSTED-PRODUCT ◄───────── identity + data + telemetry + release
  BILLING-ENTITLEMENTS ◄─── identity + data (+ explicit business authority)
  PRODUCT-ANALYTICS ◄────── telemetry + privacy

Wave D — serial whole-product recovery
  fresh whole-goal auditors -> repair contracts -> disjoint repairs
  -> cross-version/runtime QA -> artifacts/previews -> promotion gate
```

Useful parallelism is bounded by ownership and machine evidence. The repo
contract caps active slice worktrees at eight unless resource limits are
verified; each full session-manager may create its own child research,
contract, implementation, and auditor ring, but the main orchestrator must
serialize shared-file integration and active promotion.

## Minimum manager packet contract

Every manager above needs a durable directory containing:

1. `goal_<manager>.md` preserving the raw user nouns, exact objective,
   non-goals, trust boundary, measurable acceptance, and explicit unknowns.
2. Research packets from at least topology, current primary-source/API,
   dependency, data/security, quality-gate, and risk passes where relevant.
3. A contractor-produced hard contract: owned paths/interfaces, branch and
   worktree, edge cases, forbidden shortcuts, CRAP/complexity/resource targets,
   tests/benchmarks/mutation or coverage gates, acceptance commands, blockers,
   and escalation criteria.
4. An implementer report with changed paths, commands, failures, residual risks,
   claims, and tradeoffs.
5. Independent claims ledger and specialized auditor ring. Security and
   anti-gaming are mandatory for identity, data, billing, deployment, model
   tools, browser sandboxing, and telemetry.
6. Preview/artifact, provenance digest, rollback path, compatibility and
   drain/resume evidence for deployable work.

## Claims audit

| Claim | Evidence checked | Verdict |
|---|---|---|
| P0-P6 capture the original pasted request's main product arc | user capture; active goal | **verified**, but only as a high-level spine |
| P0-P6 capture all durable intents in the repository and later user stack | all OpenSpec task files; platform stack research | **refuted**; at least eleven distinct responsibility/program managers are missing |
| Wave 1 means P1 voice is fully finished | claims/merge ledgers; unchecked streaming/provider tasks | **refuted**; deterministic diagnosis/sampling slice is green, live and streaming completion is not |
| Checked OpenSpec boxes prove current completion | task files only | **unproven** until source/gates/artifacts are independently inspected and re-run |
| More agents or stronger models alone provide more capability | workflow and model-selection packet | **refuted**; capability comes from bounded ownership, evidence, contracts and adversarial verification; stronger models are justified for cross-cutting/high-risk work |
| Telemetry, payments, and hosted identity are already covered as cross-cutting rows | goal and stack map | **refuted as execution coverage**; a row without a manager, contract, lane, and gates is not materialized work |
| Any benchmark or production reliability score was measured in this audit | no benchmark/provider/production run performed | **refuted**; all such outcomes remain unmeasured |

## Required repair to the portfolio program

1. Keep P0-P6; do not discard the existing spine.
2. Add the missing managers above to the durable program index and give each a
   dependency state: `ready`, `research-ready`, `contract-blocked`,
   `authority-blocked`, or `integration-blocked`.
3. Start research-ready managers in parallel, especially identity/security,
   data, Aggie protocol, telemetry/observability, provenance, and release ops.
4. Do not launch implementers until a contractor reconciles each manager with
   overlapping OpenSpec changes and assigns disjoint ownership.
5. Maintain a portfolio-level requirement ledger so an item cannot disappear
   when its implementation is absorbed into a broader lane.
6. Reserve user escalation for true business/authority choices: paid vendor or
   benchmark spend, payment provider/pricing/tax posture, production data
   migration, sensitive retention/consent, and active promotion when its gate
   cannot be proven automatically.

## Residual unknowns

- This audit reconstructed durable intents from the supplied capture and this
  repository. Other repositories or conversations not present in these sources
  may contain additional intents and require a separate cross-repo inventory.
- Current production state, traffic, tenant count, backup recency, costs, and
  active deploy version were not inspected.
- No vendor/model comparison was run; model and observability vendor choices
  remain architecture/evaluation questions, not measured rankings.
- Some checked OpenSpec work may be fully implemented and deployed, but task
  checkmarks and history alone are insufficient evidence for this audit.
