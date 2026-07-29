# Tasks

Each stage is independently shippable and reversible on its own, and stages
are ordered so no stage requires an irreversible migration coupled to new
code in the same release (per `AGENTS.md` active-promotion safety). Ticket
numbers in parentheses refer to
`reference/openspec/changes/production-grade-hosted-product/tasks.md`, which
remains the source ticket list; this file only resequences and adds the two
new items (marked NEW).

## Stage 0 — Precondition (owned by a different lane, tracked here as a gate)

- [ ] 0.1 Fix VPS auto-deploy so master and the running `vps-deploy` ref are
  reconciled (`m4-promotion-plane-blocker`). Not part of this change's scope;
  recorded as a hard gate before Stage 3+ can reach real users.
  Acceptance: `/health`'s `build.git_sha` matches current `origin/master`
  within the normal ~2-minute promotion window, verified once.

## Stage 1 — Finish the read-path migration already in flight (Phase 1.3-1.4)

- [ ] 1.1 (P1 1.3) Switch `server.js` read paths to the relational tables in
  remote modes; keep file reads as the `local`-only fallback.
- [ ] 1.2 (P1 1.4) Make remote modes fail fast rather than silently fall back
  to files when a projection is unavailable.

Why first: every later stage (auth, BYO wiring, billing) writes and reads
`user_id`-scoped rows. Proving those reads serve real traffic before
anything depends on them is the cheapest place to catch a schema or
performance problem.

## Stage 2 — Auth (Phase 2, all `[ready]` except 2.5)

- [ ] 2.1 (P2 2.1) Add the better-auth module + tables behind `MOA_AUTH`,
  seeding the owner user so pre-auth events keep a stable author.
- [ ] 2.2 (P2 2.2) Anonymous session plugin: first visit gets a usable
  session immediately.
- [ ] 2.3 (P2 2.3) Server-side trial counter per anonymous user.
- [ ] 2.4 (P2 2.4) Email + passkey sign-up with anonymous-to-account linking.
- [ ] 2.5 (P2 2.5) Extension device-registration login surface (per-device
  token from an authenticated session).

## Stage 3 — BYO model access (NEW: faster path than Phase 3.3-3.4)

- [ ] 3.1 NEW — Wire the gateway's LLM call sites
  (`gateway/server.js`, currently keyed off module-level `MODEL_ID`/
  `MODEL_API_KEY`) to resolve the authenticated user's `account_connections`
  row for the configured provider first, decrypt via the existing
  `account-connections.js` credential path, and fall back to the operator env
  key only when no connection exists.
  Acceptance: a user with a connected `openai` account_connection gets a
  model call made with their decrypted key (verified by the provider
  request's credential source, never logged or returned to a client); a user
  with no connection gets the operator's key unchanged from today's behavior.
- [ ] 3.2 NEW — Confirm local-model BYO (`MODEL_BASE_URL` pointed at an
  OpenAI-compatible local server such as Ollama/LM Studio) continues to work
  per-deployment; document that this path is not yet per-user and note it as
  a `self_host_operator`-equivalent policy in the `virtual_key` model when
  that lands.
- [ ] 3.3 (P3 3.1) `KeyVault` interface with Postgres-envelope encryption —
  only if `account_connections`' existing AES-256-GCM storage is judged
  insufficient once 3.1 is in use; otherwise treat `account_connections` as
  the BYOK backend and skip building a second one.
- [ ] 3.4 (P3 3.3-3.5) `virtual_key` model (allowed models, routing policy,
  budget) layered on top of the credential resolution proven in 3.1, once a
  budget/entitlement is meaningful (i.e., after Stage 4 billing basics).

## Stage 4 — Billing basics (Phase 4.1-4.3, all `[ready]`)

- [ ] 4.1 (P4 4.1) Emit `usage_metered` per model call.
- [ ] 4.2 (P4 4.2) `BillingProvider` interface with a `none` default that
  meters without charging.
- [ ] 4.3 (P4 4.3) Document the Stripe implementation shape (no live wiring).

## Stage 5 — Profile becomes user-scoped (NEW, small, high user-visibility)

- [ ] 5.1 NEW — Re-key `gateway/lib/agent-profile.js`'s global record by
  `user_id` first, `device_id` second (the device-override mechanism already
  exists; this only changes what the top-level key is). Depends on Stage 2.
  Acceptance: two different authenticated users get independently persistent
  profile settings across their own devices; neither can read or mutate the
  other's profile via the device-override path.

## Stage 6 — Hosted deployment topology + provisioning (Phase 5-7)

Unchanged from the parent change; gated on Stage 0 and real demand per the
2026-07-04 "hosted-first, self-host deferred" decision. Not resequenced here.

## Verification

- Each stage: `cd gateway && npm run check`, plus the acceptance check listed
  for its tickets.
- Stage 3: a manual BYOK smoke — connect a test provider account, make one
  chat turn, confirm via provider-side usage (not gateway logs) that the
  user's key was charged, not the operator's.
- Stage 0 is verified externally (production `/health`), not by this
  worktree.
