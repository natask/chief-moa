# Landscape Research Brief: Subscription And Agent Control Plane

## Target

Research existing projects, products, and building blocks for a self-hostable or
developer-friendly control plane that can manage subscriptions, OAuth grants,
agent-accessible credentials/sessions, chat history, and automatic agent work
orchestration.

## Included Categories

- Credential vaults, OAuth brokers, token stores, secret managers, and
  subscription/license managers that can support delegated agent access.
- Browser/session/account provisioning tools that can create or maintain
  legitimate accounts, email aliases, browser profiles, and login sessions for
  agents.
- Chat-history ingestion/search/retrieval systems, especially across Claude
  Code, Codex, OpenCode, Gemini, local transcripts, and CH-like systems.
- Agent orchestration, workflow, work graph, and project-management tools that
  can launch, track, and verify autonomous work.

## Exclusions

- Credential theft, CAPTCHA bypass, rate-limit evasion, fake identity systems,
  or disposable-account abuse.
- Products that only track personal bills but do not expose APIs or agent-usable
  credential/session delegation.
- Memory products that store generic embeddings but cannot preserve source,
  project, thread, task, and verification evidence.

## Success And Adoption Signals

- Primary-source documentation for auth/session model and storage.
- Open source license and active releases where possible.
- GitHub stars/forks/release recency or package downloads for developer tools.
- Clear integration path with a Node/TypeScript gateway or local CLI.
- Supports OAuth refresh, expiry detection, audit logs, policy, or scoped
  access.
- Supports export/import, source-linked search, or local-first indexing for
  chat histories.

## Local Fit Criteria

- Preserves Chief Moa's trust boundary: gateway owns provider credentials and
  agent-run storage; Android/browser clients own local actions and approvals.
- Can plug into broker events, launcher profiles, work nodes, events, and
  artifacts.
- Avoids placing raw provider keys or third-party credentials in Android,
  browser extension source, logs, or repo files.

## Retrieval Date

2026-07-03
