# Subscription Agent Control Plane Research Report

Retrieved: 2026-07-03

## Executive Summary

No existing project is exactly the product requested: one self-hostable panel
that manages AI/SaaS subscriptions, OAuth grants, raw credentials, browser
sessions, chat histories, and automatic agent work progress. The market has
strong pieces, but not the complete Chief Moa-shaped system.

The right product direction is a Chief Moa-owned control plane composed from
four registries and one work graph:

1. Connected Account / Grant Registry
2. Persona / Agent Identity Registry
3. Browser Session Vault
4. Subscription / Provider Metadata Registry
5. CH-backed Work Graph and Artifact Store

## Best Build-On Path

Use **CH/common-chat** as the owned history substrate. Add a **CASS or
AgentsView-style index** for fast search and retrieval. Add a **Nango/Auth0
Token Vault-style OAuth registry** for connected accounts and token health. Use
**1Password/Infisical-style secret brokering** for raw secrets. Use **DBOS or
Temporal** for durable background work. Keep Android/browser approvals and
receipts as Chief Moa-owned boundaries.

## Ranking By Product Need

### 1. Credential And Subscription Control

Top candidates:

- Arcade: best reference for agent-native authorization, tool-call policy, MCP
  runtime, and audit.
- Nango: best build-on candidate for OAuth/API integration and token refresh.
- Auth0 Token Vault: best identity-backed token vault pattern for AI agents.
- 1Password Agentic Autofill: best reference for browser credential use without
  exposing secrets to agents.
- Infisical Agent Vault: best open-source credential-proxy reference.
- Torii/Zluri: best subscription/spend panel references, but not credential
  brokers.

Conclusion: build the subscription panel in Moa; do not expect a SaaS management
suite to solve agent credential delegation.

### 2. Account And Session Provisioning

Top candidates:

- SCIM/JML via Okta, Entra, SailPoint: mature account lifecycle model.
- Browserbase/Browserless/Airtop: persistent browser-session/profile patterns.
- RPA control rooms: credential vault, unattended robot, queue, receipt
  patterns.
- QA inbox tools: legitimate owned-flow email testing only.

Conclusion: support legitimate persona provisioning inside owned or
customer-authorized tenants. Do not automate consumer signup abuse. External
services should use official APIs, approved OAuth, sandbox tenants, or
user-supervised browser sessions.

### 3. Chat History Search

Top candidates:

- CH/common-chat: best local fit because it already exists and supports native
  session parsing/sync/writeback.
- CASS: best retrieval/index reference; SQLite authoritative archive plus
  Tantivy/semantic derived indexes.
- AgentsView: best dashboard/analytics reference.
- MyChatArchive: useful for web-chat exports and MCP retrieval.

Conclusion: Chief Moa should not replace CH. It should wrap CH with a stronger
index, extraction, dedupe, and work-item layer.

### 4. Agent Orchestration

Top candidates:

- LangGraph: best agent-thread/interrupt abstraction.
- DBOS: best Postgres-first durable workflow fit for the existing Chief Moa
  direction.
- Temporal: most mature durable workflow runtime.
- OpenHands Agent Canvas: best product/UI reference for a self-hosted agent
  workbench.
- browser-use/Stagehand/Skyvern/Steel and SWE-agent: useful execution backends,
  not the central control plane.

Conclusion: use Moa broker/work artifacts as the product source of truth. DBOS
or Temporal can provide crash-proof execution; LangGraph-like concepts can shape
thread/run/interrupt semantics.

## Chief Moa Architecture Map

| User Need | Chief Moa Primitive | External Reference |
| --- | --- | --- |
| One sign-in to control server | Gateway auth/session token | Auth0, WorkOS |
| Manage OAuth grants | Connected account + grant registry | Nango, Auth0 Token Vault, Arcade |
| Know when credentials expire | Grant health and notification policy | Nango/Auth0 token refresh state |
| Agents use subscriptions safely | Agent identity + allowed scopes + approval rules | Arcade, Composio, Apono |
| Browser login without leaking secrets | Browser session vault + human-approved autofill | 1Password, Browserbase |
| Account/persona lifecycle | Persona registry and SCIM-shaped state | SCIM, Okta, Entra |
| Search all chat history | CH import + FTS/BM25/vector index | CH, CASS, AgentsView |
| Turn chats into work | Extracted work-item queue | common-chat STATE/WORKFLOW, OpenHands |
| Keep work ongoing | Durable work nodes, events, artifacts | DBOS, Temporal, LangGraph |
| User approves risky actions | Approval events and receipts | Existing Chief Moa Android/browser boundary |

## First Implementation Slice

Do not begin with credential use. Begin with read-only work intake:

1. Add `ch_import_sessions` or equivalent gateway command that shells to CH or
   imports from `.chat/` without mutating native histories.
2. Store normalized session metadata and message hashes in the gateway/work
   artifact store.
3. Add a lexical search endpoint backed by SQLite/Postgres FTS or Tantivy.
4. Extract candidate work items from recent user messages with conservative
   rules: project, session id, source tool, request snippet, status, dedupe key.
5. Show candidate work items in the control center and let the user approve
   which ones become agent runs.
6. Later, add connected-account registry and grant health, still without using
   credentials automatically.

## Safety Boundary

The system may recommend account/session provisioning workflows but must not
execute external account creation without explicit user approval and a legal,
provider-allowed basis. For third-party services, prefer official APIs and OAuth
grants. Browser automation should be visible, leased, revocable, and recorded.

## Decision

Build the Chief Moa control plane. Reuse ideas and possibly libraries from
Nango/Auth0/Infisical/CH/CASS/DBOS, but keep the product source of truth in Moa:
broker events, route decisions, context packs, work nodes, agent runs,
approvals, receipts, and artifacts.
