# Browser-First Capability Map

Status: recorded 2026-07-15. Maps the settled browser-first product definition
(accepted 2026-07-14, this change's `proposal.md`) onto the existing OpenSpec
corpus and its durable objects. This document classifies; it does not authorize
implementation. The execution frontier stays deliberately small — everything
not named in "Execution frontier" is explicitly parked, not implicitly queued.

## The settled definition

Browser-first, not browser-only. The browser is the richest first surface: a
browser-native agent the user can delegate real work to, with Explain, Help,
Collaborate, and Delegate as separately addressable agents over shared
evidence/artifact/proposal/run/receipt primitives. Android stays first-class on
the same gateway. Desktop (macOS/Windows/Electron) are later distribution
surfaces. Voice reliability is the current cross-surface frontier; the VPS
one-click self-host + credential manager is the strategic wedge after it.

## 1. Execution frontier (the only active build queue)

| Change | Why it is frontier | Next ticket |
| --- | --- | --- |
| browser-situated-agent-experience (4/27) | The product definition itself; ticket 1.0 (gateway role contract) landed | 1.1 agent entry points + typed `agent` on turns (in-rz8), then 1.2 authority matrix |
| streaming-cascaded-voice (4/32) | Chunked LLM→TTS latency cut; carries the continuous-voice intent (in-9sw) | streaming turn path |
| provider-agnostic-voice-agent-runtime (24/85) | Owns canonical turn history + language state; carries strict per-turn language (in-tvs) and interruption/resume (in-5w6) | only the tickets those three intents need — the other ~55 stay parked |
| voice-delivery-controls (12/14) | Two tickets from done; closes the delivery-control loop | finish remaining tickets |

Android parity item riding the frontier: fix the stale gateway default with
migration + "wrong gateway URL" diagnostics (intent in-0pi; belongs under
define-android-core-product-map, which is otherwise 66/67 complete).

## 2. Load-bearing substrate — largely implemented, consume as-is

These are the capabilities the browser-first definition stands on. They are not
frontier work; reopen one only when a frontier ticket demonstrates a gap.

- thin-client-gateway-architecture (7/11) — extension is a thin client; the
  gateway owns secrets, state, model calls. The architectural ground rule.
- extension-gateway-roundtrip (24/25) — `/v1/browser/turns` round-trip, the
  transport the four agents route over.
- extension-browser-baseline (9/9), extension-settings-voice-control (9/9),
  extension-ui-self-extension (12/17) — load/QA, settings, engine-served UI.
- privacy-first-browser-proactive-helper (20/20) — done; the privacy posture
  for observation grants.
- gateway-runtime-agent-profile (11/11), context-thread-management (21/23),
  message-broker-session-router (17/17), durable-project-state (6/6),
  postgres-work-graph-artifact-store (9/9) — the gateway durable-object core.
- companion-catalog-profile-control (16/16), companion-character-voice-library
  (9/13), companion-pet-studio (30/36) — companion/pet product line; presence
  in the browser surfaces reuses these manifests, never a parallel store.
- remote-hosted-gateway (61/97) — the deployed api.agee.app plane; remaining
  tickets belong to the wedge (section 4), not the frontier.
- livekit-voice-transport (17/19) — measurement prototype, complete enough;
  informs but does not gate the cascaded pipeline.
- define-android-core-product-map (66/67) — Android first-class surface,
  effectively complete except the gateway-default fix noted above.

## 3. Durable objects the definition relies on

| Object | Owner change | Browser-first role |
| --- | --- | --- |
| Canonical sessions / voice turns / audio history | provider-agnostic-voice-agent-runtime | evidence + replay for every voice interaction |
| Browser turn/evidence records, browser task/run + typed role/authority | extension-gateway-roundtrip + this change's ticket 1.0 | the four-agent routing substrate |
| Observation anchors (page/layout epoch, geometry, provenance) | this change | grounding: "understands what you are looking at" |
| Agent profile (versioned, runtime-editable) | gateway-runtime-agent-profile (+ voice-delivery-controls fields) | per-user behavior without redeploys |
| Threads / context decisions | context-thread-management | continue/fork/incognito across surfaces |
| Broker events, session/project registry | message-broker-session-router | inbound-turn classification and run linkage |
| Project brief | durable-project-state | delegated background work starts from durable context |
| Work-graph events + artifacts | postgres-work-graph-artifact-store | delegated-run outputs and receipts |
| Companion / character / pet manifests | companion-* changes | one companion identity across page, workspace, Android |
| Proposals / approvals / receipts | invariant across changes (this change, apple, macOS, capability-routing) | model output is a proposal — the non-negotiable boundary |
| Users / accounts / virtual keys (BYOK) | production-grade-hosted-product, remote-hosted-gateway | hosted + self-host identity/credential plane (wedge) |
| Event envelope (append-only, idempotent) | self-hostable-event-substrate | hosted-vs-self-host parity contract (wedge) |

## 4. Strategic wedge — queued after the frontier, not alongside it

VPS one-click deploy + self-hosted credential manager (intent in-s1f):
production-grade-hosted-product (6/38), remote-hosted-gateway remainder,
self-hostable-event-substrate (11/32), publish-self-hosted-alpha (0/23).
These form one coherent lane; do not start them piecemeal from the frontier.

## 5. Explicitly parked (spec-only or paused; not the frontier)

- canonical-intent-runtime, historical-intent-to-implementation,
  voice-intent-completion-loop — intent/meta layers; valuable, but they model
  work about work. Park until the frontier ships.
- context-aware-capability-routing (2/30), per-surface-agent-skills (1/21),
  unify-work-assistance-primitives (3/10), define-aggie-compatible-surface
  (6/20) — cross-surface generalizations of what the browser slice must first
  prove concretely. The browser-situated change is their proving ground.
- cross-surface-update-delivery (0/31), tiered-ota-delivery (0/24) —
  distribution plumbing for the later desktop surfaces.
- define-apple-native-aggie-surface (8/11), privacy-first-macos-surface
  (12/18), windows work — later distribution surfaces by decision.
- voice-capture-notebook-ime (0/33), voice-capture-draft-controls (0/17),
  voice-first-orb-gestures (spec-only) — capture/UX extensions behind the
  reliability frontier.
- open-voice-reliability-control-plane (4/30) — evidence plane; adopt pieces
  as the frontier's QA needs them, not as its own lane.
- in-app-modification-requests (0/12) — Android feedback loop, spec-only.
- native-model-web-search (5/10), telemetry-observability-foundation (4/7),
  decompose-oversized-source-files (11/31) — ongoing hygiene/enrichment;
  progress opportunistically, never as the frontier.

## Rule of use

When new product direction arrives, place it in this map first: frontier,
substrate gap, wedge, or parked. If it displaces a frontier item, remove that
item explicitly — the frontier does not grow by accretion.
