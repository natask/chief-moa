# Production-grade hosted product

This change is the umbrella that turns chief-moa from a file-backed single-owner
gateway into a production-grade hosted product with anonymous-first accounts, a
real database, per-user model/key management, a billing seam, and a first-class
agent-driven self-host path. It builds on and consolidates prior changes rather
than restarting them: `remote-hosted-gateway` (one image, `MOA_MODE`, better-auth
progression, worker-pull, account connections), `self-hostable-event-substrate`
(Postgres event log with a local fallback), and `postgres-work-graph-artifact-store`.

## USER DECISIONS (nothing past documents proceeds without these)

These are load-bearing. Each downstream ticket names the decision it waits on.

1. **One image vs microservices.** RECOMMENDATION: one deployable image with
   internal service boundaries (modules), not separate deployed services. The
   agent-driven self-host flow provisions one VPS and runs one container; a
   microservice mesh would make that flow, its backups, and its restore checks
   far harder for a solo self-hoster, and it fights the recorded one-image
   decision. Keep auth, key-management, billing, and event-store as internal
   modules with narrow interfaces so any one can be extracted to a worker later
   without changing Android or extension protocols. See design.md "Decision:
   one image, internal service boundaries." **User must confirm or override.**

2. **Auth engine.** RECOMMENDATION: better-auth (already chosen in
   `remote-hosted-gateway`, Postgres-native, runs in-process, self-hostable, has
   email + passkey + anonymous plugins). The anonymous-trial to account
   requirement maps directly onto better-auth's anonymous plugin plus account
   linking. **User must confirm better-auth vs an alternative (e.g. Ory
   Kratos/Hydra, SuperTokens, Zitadel).**

3. **BYOK key storage backend.** The five-wants research picked Infisical for raw
   keys and Nango for OAuth. For the in-product BYOK path RECOMMENDATION: store
   encrypted keys in the gateway's own Postgres with an env-provided master key
   (envelope encryption), and treat Nango/Infisical as an optional external
   vault the self-host operator can point at. Reason: a self-hoster should not be
   forced to run Nango + Infisical to use BYOK; the built-in encrypted store must
   work with zero extra services, with external vaults as an upgrade. **User must
   confirm built-in encrypted store as the default vs mandating Nango/Infisical.**

4. **Subscription/metering model.** RECOMMENDATION: adopt LiteLLM's virtual-key +
   per-key budget/spend model conceptually (a `virtual_key` maps a user to an
   allowed model set, a spend counter, and a budget), metered by the gateway's
   own event log, with a pluggable billing provider (Stripe) behind a seam.
   Design-only in this change. **User must confirm Stripe as the first billing
   provider and whether metering is per-token, per-request, or seat-based.**

5. **Multi-tenant now or later.** RECOMMENDATION: build per-user scoping into the
   data model now (every event, connection, key, and run carries a `user_id`)
   but keep hosted deployment single-tenant-per-owner until real multi-tenant
   hosting is funded. `remote-hosted-gateway` left this as an open question; this
   change resolves the *data model* (scope now) but defers *tenant isolation
   hardening* (row-level security, per-tenant rate limits). **User must confirm
   scope-now-isolate-later vs full multi-tenant now.**

## Why

The current system stores conversations, voice turns, agent runs, browser tasks,
tool requests, and profiles as JSON/JSONL files under `DATA_DIR`. An optional
Postgres event substrate exists (`gateway/lib/event-substrate.js` +
`gateway/schema.sql`) and is dual-written, but the read paths still load from
flat files. There is one anonymous owner behind a single `MOA_GATEWAY_TOKEN`.
There is no login, no per-user key management, no billing seam, and self-hosting
is a manual runbook rather than a capability you can ask the agent to perform.

The user wants: a proper database as the source of truth; production-standard
tooling; auth where people actually log in to set up their Chrome extensions;
anonymous use first then account creation to continue; a model-management service
over an API where users bring their own keys (BYOK) or use their subscription;
hosted deployment; and first-class agent-driven self-hosting, where from the
extension you tell the agent "configure and self-host this for me" and it
provisions a VPS, applies customizations, and points the client at it. Hosting
is "just another question you can ask the model." The auth pipeline must be
self-hostable too.

## What

- **Postgres source of truth.** Migrate the gateway read paths off flat files
  onto the event substrate + projections. Keep the file fallback for `local`
  mode only. Provide a one-way migration that imports existing `DATA_DIR` files
  into Postgres so a running deployment loses no history.

- **Auth service (anonymous-first).** Layer better-auth so a first visit gets an
  anonymous session that can use the product immediately; continued use past a
  trial boundary requires creating an account, which links the anonymous
  session's data to the new user. Issue per-device tokens for the extension and
  Android from an authenticated session. The whole auth path runs in-process and
  is self-hostable with no external identity provider required.

- **Model/key management service.** A per-user virtual-key layer: each user has
  one or more virtual keys that map to an allowed model set, a routing policy
  (BYOK provider key, hosted subscription pool, or self-host operator key), and a
  spend/budget counter. BYOK keys are stored encrypted (envelope encryption with
  an env master key) and never returned to clients or placed in model context.
  Routing chooses the credential at call time based on the virtual key's policy.

- **Billing/subscription seam (design only).** Define where metering events are
  emitted, how a virtual key's budget is checked before a call and decremented
  after, and the interface a billing provider (Stripe first) implements. No live
  billing integration in this change.

- **Hosted deployment topology.** One image on a DigitalOcean droplet behind
  Cloudflare proxied DNS, Postgres on the droplet (or managed), blobs on a
  persistent volume, static frontend on Cloudflare Pages. Reuse the compose
  stack and MOA_MODE work from the stranded branches.

- **Agent-driven self-host provisioning.** Expose provisioning as a gateway agent
  capability: a tool the model can call (on the worker-pull execution machine)
  that runs the existing VPS bootstrap/update/backup/restore scripts to stand up
  a self-hosted gateway, apply the user's customizations, and hand back the new
  engine URL + a device token so the extension re-points itself. The model
  proposes; the human approves the provisioning and the final client re-point.

- **Extension/Android login UX boundary.** The extension gains a login surface
  that authenticates to the gateway and stores only a gateway URL + per-device
  token. Android keeps ownership of approvals, permissions, and local action
  execution per AGENTS.md; the login surface never moves that authority.

## Non-Goals

- No microservice mesh. Internal module boundaries only (pending decision 1).
- No live Stripe integration. Billing is a design seam only.
- No full multi-tenant isolation hardening (row-level security, per-tenant rate
  limits). Data model scopes by `user_id`; isolation hardening is a later change.
- No mass agent account provisioning, SMS farms, or CAPTCHA bypass. Agent
  identity provisioning stays out of terms per the five-wants runbooks and is out
  of scope here.
- No object storage cutover. Blobs stay on a persistent volume; S3 is a named
  later step (inherited from `remote-hosted-gateway`).
- No new voice/browser behavior. This change does not touch voice provider
  routing or the browser voice loops beyond adding auth in front of them.

## Impact

- Storage: Postgres becomes the source of truth in remote modes; flat files
  become a local-dev fallback and a one-time migration source.
- Auth: anonymous sessions, accounts, and per-device tokens replace the single
  owner token, without changing what clients store (URL + token).
- Model calls: every model call resolves a virtual key and a credential at call
  time; BYOK keys live encrypted in Postgres.
- Deployment: one image, hosted on a droplet, self-hostable by the same image,
  provisionable by an agent capability.
- Clients: the extension gains login; Android keeps approval authority.

## Dependency note

- **Blocked on branch consolidation (task #4).** Tickets that touch
  `gateway/server.js`, the Docker/compose stack, `MOA_MODE`, the worker-pull
  control plane, the account-connection store, and the VPS scripts depend on
  landing `codex/vps-agent-control-plane` and `worktree-agent-af6a296e02865afd2`
  to master first. They are marked `[blocked: consolidation]` in tasks.md.
- **Owned by in-flight worktrees right now.** `gateway/lib/voice-providers.js`
  and the `server.js` history read paths are being edited by active voice
  worktrees (`codex/live-voice-browser-continuity`, `codex/voice-pipeline-e2e-fix`).
  The read-path migration (Phase 1) must not start on those exact lines until
  those worktrees land. Tickets that can start immediately touch only new files
  (auth module, key-management module, migration script, specs) and are marked
  `[ready]`.
