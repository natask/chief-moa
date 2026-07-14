# Context-Aware Capability Routing Design

## Context

Existing Moa paths already provide important primitives: browser page evidence,
Android accessibility snapshots, a gateway device-client registry, local tool
manifests, browser agent tasks, approvals, and receipts. The missing layer is a
shared resolver that can combine those primitives with service identity,
connected accounts, and project context.

This design deliberately separates five questions:

1. What app, site, or document is in front of the user?
2. Which service and project does that evidence relate to?
3. Which useful capabilities exist for that service?
4. Which authenticated connection or local executor can perform each one?
5. Which owning surface must approve, revalidate, execute, and receipt it?

## Goals / Non-Goals

**Goals:**

- One reusable resolver for browser, Android, macOS, Windows, and future
  surfaces.
- Easy account connection through standard OAuth/OIDC without placing provider
  credentials on clients.
- Safe reuse of browser sessions the user has already authenticated.
- Deterministic preference and fallback between official APIs and UI execution.
- Project-aware ranking and receipts that explain what happened and where.
- A stable model execution seam whose schema does not grow once per app.

**Non-Goals:**

- A general credential extractor or remote browser-cookie jar.
- Arbitrary model-authored integrations or action code.
- A promise that every application exposes the same operations.
- Silent failover between accounts, projects, or devices for side effects.
- macOS/Windows implementation before the browser/Android contracts are proven.

## 1. Canonical Observation

Every surface emits a bounded `observation.v1` envelope:

```json
{
  "version": 1,
  "observation_id": "obs_uuid",
  "captured_at": "RFC3339",
  "expires_at": "RFC3339",
  "surface": {
    "surface_id": "surface_uuid",
    "surface_type": "browser_extension|android|macos|windows",
    "device_id": "device_uuid"
  },
  "subject": {
    "kind": "web_page|application|document",
    "application_id": "android package, Apple bundle id, or Windows app id",
    "origin": "https://example.com",
    "url": "optional bounded URL",
    "title": "optional bounded title",
    "document_id": "optional stable opaque id"
  },
  "evidence": {
    "summary": "bounded redacted text",
    "selection": "optional explicit selection",
    "element_labels": ["bounded labels"],
    "content_digest": "sha256:..."
  },
  "capture": {
    "user_initiated": true,
    "permission_class": "explicit_turn|timed_context_grant|local_only",
    "redactions": ["rule ids"]
  },
  "project_hints": [
    {"project_id": "project_uuid", "source": "explicit|origin|thread|user_rule", "confidence": 1.0}
  ]
}
```

Only fields relevant to the subject kind are present. Raw screenshots, full
accessibility trees, form values, and page bodies are not part of the default
envelope; existing bounded evidence storage may hold them under a separate
grant. The gateway rejects expired observations for execution planning. A
surface may use an expired observation for display/history only.

`application_id` uses platform-stable identifiers where available: Android
package name, Apple bundle identifier, or registered Windows application/user
model ID. Process names and titles are evidence only and cannot grant a match.
For web pages, canonical origin is authoritative; paths and titles only refine a
service-owned match.

## 2. Declarative Service And Matcher Catalog

The gateway owns a versioned, reviewable catalog. Each service entry contains:

```text
service_id, display_name, catalog_version
app_matchers[]: { platform, application_id }
web_matchers[]: { scheme, host, optional path_prefix }
capabilities[]: {
  capability_key, verb, risk_class, input_schema, output_schema,
  idempotency, required_scopes[], supported_executor_kinds[]
}
```

Exact registered application IDs and normalized HTTPS origins are preferred.
Subdomain wildcards are catalog-authored and suffix-bound; a matcher for
`*.example.com` cannot match `example.com.attacker.test`. Model output cannot
create or widen a matcher. Titles, visible text, and accessibility labels may
rank an already-established match but cannot establish service identity alone.

The starter catalog is deliberately small and acceptance-driven. It must
include one service with both an official API candidate and browser candidate,
one browser-only service fixture, and Android's app/open-URL capabilities. New
catalog entries require fixtures, least-privilege scopes, risk class, and
expected receipts rather than bespoke prompt instructions.

## 3. Connections And Executor Candidates

An official API connection is a tenant- and user-scoped record:

```text
connection_id, service_id, provider_adapter, account_label,
granted_scopes, status, credential_ref, created_at, refreshed_at, expires_at
```

`credential_ref` points to gateway-side encrypted material and is never returned
to a client or model. OAuth state, PKCE, callback binding, refresh rotation,
revocation, and reconnect state are adapter responsibilities behind a common
connection interface. The product may use Better Auth for user/account session
plumbing or an adapter for a hosted integration vendor, but canonical connection
and capability records remain Moa-owned and exportable.

A browser session is not represented as a connection credential. It is a live
executor candidate advertised by a device manifest:

```text
candidate_id, executor_kind=browser_session, device_id, surface_id,
service_ids[], capability_keys[], observed_origins[], heartbeat_at,
local_grant, busy_state
```

The extension may act inside an already authenticated page using its existing
local browser authority. It must not read/export cookie values, passwords,
authorization headers, or browser storage as gateway credentials. Android and
future native clients advertise candidates in the same way for local actions.

## 4. Resolution Result And Stable Model Interface

The resolver accepts:

```text
authenticated actor + tenant
+ current observation
+ active thread/project and explicit target overrides
+ catalog snapshot
+ healthy connections
+ fresh device manifests
-> ranked resolution
```

The result contains only bounded descriptors:

```json
{
  "resolution_id": "resolution_uuid",
  "observation_id": "obs_uuid",
  "project": {"project_id": "project_uuid", "basis": "explicit|inferred", "confidence": 1.0},
  "matches": [{"service_id": "github", "matcher_id": "web.github", "reason": "origin_exact"}],
  "capabilities": [{
    "capability_id": "cap_uuid",
    "capability_key": "issue.create",
    "candidate_id": "candidate_uuid",
    "executor_kind": "official_api|browser_session|device_local",
    "device_id": "optional device_uuid",
    "connection_id": "optional connection_uuid",
    "availability": "ready|needs_connection|needs_scope|offline|stale|blocked",
    "risk_class": "read|navigation|draft|external_side_effect|destructive",
    "approval_class": "none|implicit_user_command|explicit_preview|explicit_confirm",
    "reason_codes": ["service_match", "scope_present", "device_fresh"]
  }]
}
```

The model receives relevant descriptors in its bounded context and uses one
generic `execute_capability` operation with `resolution_id`, `capability_id`,
structured inputs, and an optional explicit device/connection override. A
connector does not dynamically register an additional model tool. The gateway
validates the descriptor snapshot, schema, actor, project, connection/device,
freshness, and approval class again before creating a proposal.

Rank order is deterministic before model reasoning: explicit user target;
service match strength; project/account binding; ready versus missing access;
least privilege; executor-selection policy; device freshness; then stable IDs.
The returned reason codes make the result testable and inspectable.

## 5. Official API Versus Browser Session

Selection uses declared capability semantics rather than a blanket preference:

- Prefer an official API for structured reads/writes when it has the required
  least-privilege scopes, preserves the requested account/project identity, and
  can return a durable resource identifier.
- Prefer the current browser session for work on unsaved page state, a UI-only
  operation, an explicit request to act "here/on this page," or when no healthy
  official connection supports the capability.
- Prefer a device-local executor for OS permissions, local files, app launches,
  accessibility actions, or other authority owned by that device.
- A browser fallback must not be used to evade a missing API scope or an API
  policy denial. It is eligible only when UI execution is independently allowed
  and locally approved.
- Read-only candidates may fail over within the same explicit account/project.
  Side-effecting candidates require renewed approval before changing executor,
  account, project, or device.

The proposal preview names the chosen service, account label or browser device,
project, effect, and fallback policy. The user can override a ranked candidate
without changing the catalog.

## 6. Project Linkage

An explicit project selected by the user or active thread wins. Otherwise the
resolver may infer a project from user-authored origin/repository/document rules
and thread context. Inference carries a basis and confidence. Side effects at
less than the configured confidence threshold require project confirmation.

Project identity scopes retrieval, candidate ranking, proposal history, and
receipts. Visible page text cannot silently relink a thread or action to another
project. A user override is stored as an inspectable rule or one-turn choice;
the UI must distinguish them. Incognito turns do not create durable project
rules or connection records.

## 7. Proposal, Approval, Execution, And Receipt

Resolution never executes. `execute_capability` creates a proposal bound to:

```text
actor, tenant, project_id, resolution_id, observation_id,
capability_id, candidate_id, connection_id/device_id, canonical inputs,
risk/approval class, created_at, expires_at, and state preconditions
```

Official API proposals are policy-checked at the gateway and require the
configured approval before the gateway connector executes. Browser/device-local
proposals are delivered to the owning surface, which checks its local manifest,
permission/grant, approval, current app/origin/package, observation digest, and
expiry immediately before execution.

Every attempt produces a terminal or resumable receipt containing proposal ID,
selected executor, project, timestamps, status, bounded result/error, external
resource identifier when available, local-state digest, and idempotency key.
Receipts never contain credentials, cookies, full page bodies, or unredacted
accessibility trees. The gateway stores receipts so the initiating surface and
other authorized surfaces can inspect the same outcome.

## 8. Multi-Device Targeting

Fresh device manifests are candidates, not authority. An explicit user-selected
device wins if it advertises the capability and is fresh. Otherwise ranking may
choose a fresh compatible device using active observation ownership, project
affinity, and last-used preference. The proposal always identifies the target.

The owning client claims the proposal, revalidates locally, and receipts it.
Offline work remains queued with an expiry or returns `offline`; the gateway
does not silently retarget a side effect. Duplicate claims are idempotent, and a
receipt from a device other than the bound target is rejected.

## 9. Concrete Acceptance Cases

### Browser: authenticated service with API and session candidates

Given the user is viewing a catalog-matched GitHub repository page, the browser
manifest is fresh, and a GitHub API connection has the required issue-write
scope, resolving "create an issue from this selection" returns both candidates,
ranks the official API first, links the repository project, and explains the
ranking. Execution creates a preview; after required approval, the API receipt
contains the created issue identifier. No browser cookie appears in gateway
records or network payloads.

### Browser: current unsaved draft

Given the current matched page contains an unsaved draft and the request says
"finish this draft here," the browser-session candidate ranks ahead of an API
candidate because current UI state is required. The extension revalidates the
origin and observation digest, modifies only the draft, and returns a local
receipt. Sending/publishing remains a separate explicit-confirm proposal.

### Browser: logged in locally, no API connection

Given a user is authenticated in the browser but has no official connection,
the resolver reports the API candidate as `needs_connection` and the browser
candidate as `ready`. It can complete an independently permitted UI action
without extracting cookies or pretending that the browser login is an OAuth
connection.

### Android: matched foreground app

Given Android observes a catalog-matched package and the user asks to open a
bounded URL in that app, the resolver chooses the fresh Android device-local
candidate. The proposal binds the expected package and observation. Android
revalidates the foreground package immediately before execution and returns a
receipt containing the before/after package IDs and no raw screen text.

### Android: stale foreground state

Given the foreground package changes after resolution but before an
accessibility action, Android rejects the proposal as `stale_state`, performs no
tap, and returns a receipt. The gateway may resolve again from a new observation
but may not replay the old proposal.

### Cross-device: request from Android, execution in browser

Given a browser device advertises a ready session candidate for the matched
service and Android has no local executor for the requested page operation, the
Android-started turn targets that browser. The browser claims, approves when
required, revalidates, executes, and receipts the action. If that browser goes
offline, a side effect remains queued/blocked rather than moving silently to a
different browser.

## Migration Plan

1. Add shared schemas and a deterministic in-memory/keyless catalog resolver.
2. Adapt existing browser page evidence and Android package snapshots to
   `observation.v1` without removing their current paths.
3. Add the connection adapter interface and one test/deterministic provider;
   prove OAuth state and credential non-disclosure before a live provider.
4. Adapt browser-agent and device-hub manifests into executor candidates.
5. Add proposal/receipt binding and the generic execute-capability seam.
6. Ship a minimal real service catalog entry behind an opt-in flag, verify the
   browser cases, then verify Android package-bound execution.
7. Expand services only through catalog fixtures and connector adapters.
8. Reuse the protocol for macOS and Windows after browser and Android evidence
   is green.

## Open Questions

- Which first live official integration best exercises both read and draft/write
  behavior without broad scopes: GitHub, Google Calendar, or another service?
- Should project-confidence thresholds be global defaults with per-project
  overrides, or only explicit per-project policy?
- The repository's existing encrypted gateway store remains the first live
  credential backend. Self-hosted Nango Auth + Proxy is the first external
  broker candidate, gated by license review and backup/restore evidence; see
  `connector-framework-decision.md`.
- Better Auth remains an evaluated candidate for Moa identity and device OAuth,
  not provider-integration brokering or execution authority; see
  `connector-framework-decision.md`.
