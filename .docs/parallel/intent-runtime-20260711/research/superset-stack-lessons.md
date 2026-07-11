# Superset stack lessons for Chief Moa

Checked: 2026-07-11. The source checkout at
`/Users/natnaelkahssay/projs/superset` contains unrelated uncommitted user work,
so this pass inspected committed `HEAD` wherever a path was dirty. It made no
changes to Superset and did not read environment files.

## Why this is the remembered exceptional reference

Superset is not merely an agent launcher. Its committed repository contains the
pieces required to ship and operate a full software product:

- a Bun/Turborepo monorepo with shared TypeScript, UI, auth, database, agent,
  chat, MCP, filesystem, and host-service packages;
- an Electron/React desktop control plane, Next.js API and web apps, an Expo
  mobile app, docs, admin, marketing, sync, and proxy surfaces;
- local SQLite/Drizzle state for projects, worktrees, workspaces, settings,
  terminals, tasks, and browser history;
- hosted PostgreSQL/Drizzle state for organizations, tasks, integrations,
  subscriptions, devices, presence, remote workspaces, commands, and chats;
- worktree-isolated agents, provider adapters, MCP, terminal/process control,
  diffs, and remote-host support;
- contribution documentation, migrations, lint/test/typecheck/build CI,
  per-pull-request application and database previews, desktop canary/stable
  release automation, update manifests, and cleanup workflows;
- a documented fork-and-bundle lifecycle for upstream agent infrastructure
  (`mastracode`), including deterministic versioned artifacts.

That breadth is the important association: a credible product is the product
plus its migration, preview, release, rollback, documentation, contribution,
dependency-fork, and operational systems.

License boundary: the checkout's controlling `LICENSE.md` is Elastic License
2.0 even though its README and package metadata say Apache-2.0. These notes
extract architectural ideas only. Chief Moa must not copy Superset code or
describe Superset as open source without a separate license/provenance review;
Emdash is the Apache-2.0 member of the recovered pair.

## Patterns Chief Moa should adopt

1. **Explicit surface boundaries.** Keep Android execution/approval, browser
   context, gateway routing/storage, intent authority, and optional integrations
   as separately owned modules with typed contracts.
2. **Local and hosted state are different products.** Local capture should keep
   working without a hosted control plane. Sync is an explicit projection with
   conflicts, migrations, privacy, and deletion behavior—not an implicit second
   authority.
3. **Isolation is a product feature.** An intent may launch a worktree, agent,
   CI run, or remote workspace, but those execution environments remain linked
   children with receipts rather than becoming the intent itself.
4. **Previews must isolate state too.** Superset's preview workflow creates a
   pull-request database branch and separate service/application targets. Chief
   Moa should preserve the same standard for recordings, draft stores, queues,
   and workers, not only use a different URL.
5. **Adapters should be replaceable.** Agent providers, model providers, CI
   optimizers, trace backends, and software-factory surfaces attach at stable
   boundaries; none owns canonical intent or conversation history.
6. **Forks need a lifecycle.** If Chief Moa must patch an upstream voice or
   agent library, pin a reproducible artifact, document origin/upstream remotes,
   record the delta, test it, and define how it is rebased or retired.
7. **Operational completeness is part of the feature.** Migrations, test gates,
   preview artifacts, update channels, rollback, contribution guidance, and
   self-hosting documentation are acceptance criteria, not post-launch chores.

## What not to copy

- Superset's workspace/task schema is optimized for coding-agent environments;
  it does not model Chief Moa's cross-project intent lifecycle, focus stack,
  voice draft, canonical turn, action approval, or rehydration semantics.
- Its Electron terminal-and-diff center is not the target mobile voice
  interaction. Chief Moa should integrate with a software factory rather than
  reproduce its desktop IDE.
- Hosted organization, billing, sync, and integration machinery is premature
  unless a concrete Chief Moa use case requires it. Data ownership does not
  require reproducing a SaaS control plane.
- Product analytics and crash telemetry are derived operational projections.
  They cannot substitute for the owned voice transaction, intent, and receipt
  stores.

## Resulting product map

```text
Chief Moa (intent and conversation authority)
  -> software-factory adapter: Superset / Emdash / another executor
  -> CI evidence and optimization adapter: GitHub Actions / StarSling / other
  -> diagnostic projection: bounded OTel -> optional Langfuse / Phoenix
  -> voice runtime adapter: current cascaded pipeline / future provider
  -> contextual agent brief: failures + novelty + recurrence + priority + code
```

The immediate implementation remains deliberately narrower: create durable
intent and voice-draft authority, then bind the existing Android, browser, and
gateway paths to it. The broader Superset lesson determines how that slice is
packaged and operated, not additional scope for this release.
