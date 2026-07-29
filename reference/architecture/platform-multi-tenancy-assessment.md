# Platform multi-tenancy assessment

Snapshot date: 2026-07-28. Written for the question "should we divide up the
single VPS to support auth, payments, telemetry, a real database, and
bring-your-own-model users." This is a read-only assessment (no droplet
access beyond `GET /health`) against the `feat/platform-infra-20260729`
worktree at commit history through `2b505068`.

**Headline finding: this question was already asked and answered on
2026-07-04.** `reference/openspec/changes/production-grade-hosted-product/proposal.md`
records five user decisions (one image vs microservices, auth engine, BYOK
storage, billing/metering model, multi-tenant timing) and a `tasks.md` staged
plan across 8 phases. Roughly a third of Phase 0/1 landed by 2026-07-08
(consolidation, Postgres relational schema with `user_id` on every row,
dual-write, a file-to-Postgres importer). Nothing in Phases 2-7 (auth,
BYOK/virtual-key routing, live billing, extension login) has started since.
Do not re-derive those five decisions; this document assesses what changed on
the ground since, and answers the "split the droplet" question the prior
change deferred.

## 1. Inventory: what exists today

### Identity / auth

There is no user account system. Every request authenticates with one shared
bearer token (`gateway/server.js:267` `MOA_GATEWAY_TOKEN`), checked by string
comparison in several places (`gateway/server.js:12878-12994`). The only
notion of "a user" is a hash derived from that one token:

```js
// gateway/server.js:1263-1272
// Connections are scoped to an authenticated user. Until the better-auth user
// base lands, the gateway runs single-user: the identity is derived from the
// gateway token so a token rotation starts a fresh scope...
function accountUserId() {
  if (!MOA_GATEWAY_TOKEN) return "usr_local";
  return `usr_${crypto.createHash("sha256").update(MOA_GATEWAY_TOKEN).digest("hex").slice(0, 16)}`;
}
```

The comment is accurate and current: the resolver is already isolated so a
real auth system only has to replace this one function, not the stores. That
groundwork is real and should be reused, not rebuilt.

The relational schema (`gateway/migrations/1783296000001_relational-v1.js`)
already has a `users` table with `kind in ('owner','anonymous','account')`,
`is_anonymous`, and `auth_user_id` — built in anticipation of better-auth
(Phase 2 of the hosted-product plan) but never wired to an actual login flow.
`better-auth` is not in `gateway/package.json`. No sign-up, session, or
per-device token issuance exists.

Confirmed live at `https://api.agee.app/health` right now: `"auth_mode":
"gateway-token"`, `"future_auth_enabled": false`.

### Database — what's user-scoped vs global

Two Postgres roles exist, and they tell different stories:

- **`release_control_plane`** (`release_control_plane/migrations/001_release_control_plane.sql`)
  is genuinely tenant-aware today: every table carries `tenant_id`, Postgres
  Row-Level Security is turned on and forced (`force row level security`),
  and a per-connection `set_config('moa.tenant_id', ...)` scopes every query
  (`gateway/lib/device-credentials.js:162`). But `tenant_id` here means "which
  application/release graph" (there's one: chief-moa), not "which paying
  customer." It's a proof that the codebase already knows how to do RLS-backed
  multi-tenancy correctly — it just hasn't been pointed at customers yet.
- **The gateway's own schema** (`gateway/schema.sql`,
  `gateway/migrations/1783296000001_relational-v1.js`) has `user_id` on every
  relational table (sessions, branches, turns, voice_turns, agent_runs,
  browser_tasks, tool_requests, agent_profiles) per Phase 1 task 1.0, done
  2026-07-06. FORCE RLS is scaffolded with a non-owner `moa_app` role. This is
  real progress toward multi-tenant data. But it is **half-wired**: task 1.3
  ("switch `server.js` read paths to the relational tables") is still
  unchecked, so `server.js` still reads/writes flat files under one global
  `DATA_DIR` for the actual live paths (conversations, voice turns, profile,
  browser tasks — `gateway/server.js:204-243`). The dual-write proven in task
  1.1 writes to Postgres in parallel but does not replace the read path yet.
  Confirmed live: `/health` reports `"data_dir": "/data"` — one directory,
  one tenant.
- **Billing** (`gateway/migrations/1783296000002_billing-domain.js`,
  `gateway/lib/billing-domain.js`) has real per-`user_id` schema — price
  versions, usage facts, entitlements, budget reservations, webhook receipts —
  with FORCE RLS and a deny-update/delete policy, matching
  `ARCHITECTURE.md`'s "Billing and entitlement boundary" section. It is
  design/sandbox-only: no real payment provider is wired, and every route
  reports `sandbox_no_charge`.

### Provider credentials — where they live, and the BYO gap

`AGENTS.md` and `ARCHITECTURE.md` are both correct that the gateway owns
provider credentials and Android must never hold them. In practice there are
**two separate, only one of which the model actually uses**:

1. **Live inference credentials**: process-level environment variables read
   once at boot — `MODEL_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`/
   `ANTHROPIC_API_KEY`, `MODEL_PROVIDER`, `MODEL_ID`
   (`gateway/server.js:255-258`, and every LLM call site references the same
   module-level `MODEL_ID`/`MODEL_API_KEY`, e.g. `gateway/server.js:4926-5699`).
   This is the credential path every real chat/voice turn actually uses today.
   It is one operator's key set for the whole deployment, full stop.
2. **`account_connections`** (`gateway/lib/account-connections.js`,
   `gateway/schema.sql:186-245`): a genuinely well-built per-user credential
   store — AES-256-GCM envelope encryption, a credential table that API
   serializers never join into, OAuth2/API-key/PAT/service-account kinds, a
   provider catalog (openai/anthropic/google/github,
   `gateway/lib/account-providers.js:50-80`), health checks
   (`gateway/server.js:820`). This is the right shape for BYOK/BYO-subscription.
   It is **not wired into the inference call path at all** — grep confirms
   zero references from the model-call code to `accountConnections`.

So the BYO story is: the storage and OAuth scaffolding for "bring your own
key or connected subscription" already exists and is well-designed, but no
model call ever asks it for a credential. This is the single highest-leverage
gap for the user's stated BYO requirement — it's a routing/wiring problem,
not a from-scratch build.

### Telemetry / observability

`reference/openspec/changes/telemetry-observability-foundation/proposal.md`
defines a Moa-owned semantic envelope and a bounded async exporter seam
(matches `ARCHITECTURE.md`'s "Telemetry and observability boundary" section).
It is explicitly design-stage: "Non-goals: selecting or enrolling in Datadog,
Sentry, an OpenTelemetry backend... Sending production telemetry or adding
client SDKs in this change." What exists operationally today is `/health`
(rich, but a manual pull, not alerting) and OTA/deploy receipts
(`DEPLOYMENT.md`) — good build/release evidence, no running-service metrics,
logs aggregation, error tracking, or alerting.

### Is anything multi-tenant today?

No. Confirmed live at `/health`: one `gateway-token` auth mode, one
`data_dir`, one Vertex project, one blob bucket. `release_control_plane`'s
RLS/tenant_id machinery is real but scoped to "one application, one tenant"
today (`MOA_RELEASE_CONTROL_TENANT_ID` is a single configured value,
`gateway/lib/release-control-runtime.js:27`).

## 2. Top single-tenant assumptions

Ranked by how much they block "a second person can sign up and use their own
model access," each with the exact resolver to replace or wire:

1. **Identity is a hash of the one shared bearer token**
   (`gateway/server.js:1267-1272`, `accountUserId()`). Every "per-user" table
   built so far (`account_connections`, billing, relational store) resolves
   its `user_id` from this function. Replacing it is Phase 2's entire job —
   and because the resolver is already isolated, replacing it does not
   require touching the stores.
2. **Live inference credentials are process-env globals, not per-user**
   (`gateway/server.js:255-258` and every call site keying off `MODEL_ID`/
   `MODEL_API_KEY`). This is the actual BYO blocker: `account_connections`
   exists but nothing calls it.
3. **`DATA_DIR` is one global filesystem tree for conversations, voice
   turns, profile, browser tasks** (`gateway/server.js:204-243`). The
   Postgres-with-`user_id`-column replacement already exists
   (`gateway/lib/relational-store.js`) but the read path (task 1.3) was never
   flipped, so this remains the live behavior in production today
   (`/health`: `"data_dir": "/data"`).
4. **The agent profile is one global record with device-scoped overrides,
   not a per-account record** (`gateway/lib/agent-profile.js`, matching
   `ARCHITECTURE.md`'s "Profile settings are hard settings: global changes
   apply to every device"). This directly conflicts with the user's stated
   requirement — "their settings on their mobile are persistent in the VPS
   for that particular user" — because today "global" means "the one owner,"
   not "this one paying customer." Fixing this is a straightforward
   extension of the same device-override mechanism once `user_id` scoping
   (item 1) lands: key the profile store by `user_id` first, `device_id`
   second, instead of assuming one owner.
5. **No billing/entitlement gate exists in front of any paid route.** The
   billing schema is real but every route currently reports
   `sandbox_no_charge` — there is no code path today that could refuse
   service to a non-paying user even if accounts existed.

## 3. Recommendations

### Identity and auth — what a second user actually requires, minimally

Phase 2 of `production-grade-hosted-product` already specifies the minimal
shape correctly: better-auth in-process (already decided, already a
dependency-free choice since it's Postgres-native and self-hostable),
anonymous-first sessions, a server-side trial counter, email+passkey sign-up
with anonymous-to-account linking, and a per-device token for Android/browser
that those clients already know how to store (they only ever held a URL +
token; that shape does not change). Nothing about this needs new
infrastructure — it needs the `better-auth` package added, tables migrated,
and `accountUserId()` replaced with a real session resolver. This is real
work (Phase 2 is 5 tickets) but it is bounded and well-specified already.

### Payments — what's needed now vs deferrable

Needed to charge anyone at all: a `virtual_key`/budget record per user
(Phase 3.3, not started), a pre-call budget check (Phase 3.5), a
`usage_metered` event per model call (Phase 4.1) feeding the billing schema
that already exists, and one `BillingProvider` implementation — Stripe was
already decided as the first provider. Everything else (dunning, disputes,
tax, refunds) is explicitly out of scope per `ARCHITECTURE.md`'s billing
boundary ("Real provider, pricing, tax, refund, dispute and grace policy
remain intentionally unwired") and should stay deferred; building it before
there is a paying user to observe real failure modes against is waste.

### BYO model access — the concrete unblock

This is the one place this assessment differs from "just execute Phase 3 in
order." The fastest path to the user's stated requirement ("allow people to
use their own AI systems... locally running or their subscriptions") is not
to build a new virtual-key system first — it's to **wire the model-call path
to check `account_connections` before falling back to the operator's env
key**, for exactly the providers already in its catalog (openai, anthropic,
google). Concretely: at the top of the LLM call sites in `server.js`
(currently reading `MODEL_API_KEY`/`MODEL_ID` unconditionally), resolve the
authenticated user's active `account_connections` row for the configured
provider first, decrypt via `account-connections.js`'s existing credential
path, and fall back to the operator env key only when no connection exists
or the deployment is `self_host_operator` mode. Local models (Ollama,
LM Studio, etc.) already work today for anyone who sets `MODEL_BASE_URL` to
an OpenAI-compatible local server — that path is already BYO in the sense of
"your own infrastructure," it just isn't user-scoped yet either. The
`virtual_key` abstraction (Phase 3.3-3.4) is the right long-term shape
(it adds budget and routing policy on top), but the account-connections
wiring is unblocked *today*, requires no new schema, and directly satisfies
"use their subscription" without waiting for auth to land first — a
connection can be attached to the single owner token's `accountUserId()`
scope in the interim and re-attached to a real user id once Phase 2 lands
(the `user_id` column is already there, so this is not a wasted step).

The hard constraint holds throughout: Android never receives a provider key.
It only ever sees the gateway URL + its own device token; the connection
lives and stays server-side, exactly as `account-connections.js` already
guarantees.

### Telemetry / observability — what would actually help operate this

The telemetry-observability-foundation change's envelope design is sound and
should ship its exporter seam, but the highest-value near-term step is
narrower: wire `/health`'s existing rich JSON into an uptime/alerting check
(even a simple external ping-and-page on `ok:false` or `provider_configured:
false`) and ship structured error logging for the deploy/promotion path,
since `DEPLOYMENT.md` already produces good receipts for builds and OTA but
nothing pages a human when the live gateway itself degrades. Full
vendor-backed observability (traces, dashboards) is legitimately deferrable
until there is either a second real user or a repeat of an unattended
incident — reference `voice-crash-loop-20260706` and `m4-promotion-plane-blocker`
memory entries, both real incidents that a basic external health check would
have caught days earlier than a person noticing.

### Data — what must become user-scoped, and the migration order

In dependency order (each stage below is independently shippable):
1. Finish Phase 1.3/1.4 (flip `server.js` reads from flat files to the
   already-built Postgres relational store) — this is prerequisite plumbing,
   not user-visible, and de-risks everything downstream since it proves the
   `user_id`-scoped tables actually serve traffic before auth depends on them.
2. Land Phase 2 (auth) so `user_id` stops being a token hash and starts being
   a real account.
3. Re-key the agent-profile store (today keyed by device only under one
   global owner) by `user_id` first — this directly satisfies "settings
   persistent in the VPS for that particular user."
4. Wire `account_connections` into the model-call path (BYO, above) —
   independent of steps 2-3 in principle, but only meaningfully multi-tenant
   once step 2 lands.
5. Billing (Phase 3.3-3.5, Phase 4) — depends on step 2 for a real user to
   bill.

### Should the droplet be split? Not yet — and here's the actual trigger

The 2026-07-04 decision ("one deployable image with internal service
boundaries, not separate deployed services") remains correct and nothing
found in this assessment changes it. The reasoning holds up under the
current question too: there is exactly one tenant in production right now,
the release-control-plane pattern already proves RLS-based tenant isolation
works *inside* one Postgres without a service split, and splitting now would
add operational surface (more deploy targets, more failure domains, a
network hop between auth/billing/inference) with zero current load to
justify it. Splitting is also not free later — `AGENTS.md`'s own promotion
gate would require proving compatibility and rollback across the split, which
is easier to do once before real user data exists than after.

**Concrete trigger to revisit:** either (a) real concurrent multi-tenant
production load causing measurable contention between the inference path and
the auth/billing path on the same Postgres/process (something `/health` or
the telemetry seam above would surface), or (b) a compliance/security
requirement that specifically demands credential storage or billing run in
an isolated process/network boundary from model inference. Absent one of
those, extracting auth/billing/telemetry into separate services only adds
deploy and backup/restore surface without a matching problem it solves —
`AGENTS.md`'s active-promotion gate already requires backup/restore evidence
for every stateful surface, and a second Postgres role or service is a
second thing to prove that evidence for.

## 4. What is actually blocking progress right now

Two things outside this assessment's read-only scope, both worth flagging to
whoever executes the staged plan:

- **`m4-promotion-plane-blocker`** (per this session's memory): VPS
  auto-deploy has been dead since the deploy-hardening change landed, and
  master is 30+ commits ahead of the running production `vps-deploy` ref.
  None of Phases 2-7 below can reach real users until this is fixed — a
  hosted product with a broken deploy pipe is not shippable regardless of
  auth/billing/BYO progress.
- **Stalled execution, not a technical blocker**: Phase 1 tasks 1.0-1.2 and
  R.3 landed 2026-07-06/07-08; nothing in Phases 2-7 has moved in three
  weeks even though most of Phase 2 and Phase 3.1-3.3, 3.5 and Phase 4.1-4.3
  are tagged `[ready]` (no blocking dependency). The plan does not need new
  decisions; it needs someone to execute the next ready ticket.

See `reference/openspec/changes/resume-hosted-product-platform/proposal.md`
for the staged execution plan this assessment recommends.
