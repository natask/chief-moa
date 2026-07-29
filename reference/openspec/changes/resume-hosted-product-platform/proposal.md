# Resume and sequence the hosted-product platform work

## Status

This change does not re-open decisions. It resumes execution of
`reference/openspec/changes/production-grade-hosted-product`, whose five user
decisions (2026-07-04) remain authoritative and are not revisited here. It
adds one new finding (a concrete BYO-model-access unblock) and one new
constraint (the deploy pipeline must be fixed before any of this reaches
real users) discovered in the assessment at
`reference/architecture/platform-multi-tenancy-assessment.md`. Read that
document first; it has the file:line evidence behind every claim here.

## Why

The user asked, in fresh words, for the same thing decided on 2026-07-04:
auth, payments, telemetry, a real database, and letting people bring their
own model access. The plan for all of that already exists and part of it
(Phase 0, Phase R.3, Phase 1.0-1.2) already shipped 2026-07-06/07-08. Nothing
in Phases 2-7 has moved in three weeks even though most of Phase 2 and parts
of Phase 3/4 are tagged `[ready]` — no blocking dependency, just not picked
up. Re-deriving a new plan from scratch would waste the decisions already
made and the schema already built (per-user `user_id` columns, FORCE RLS
scaffolding, the billing domain schema, the `account_connections` credential
store). What's missing is sequencing: which ready ticket to execute next,
and two things the original plan didn't anticipate.

## What changes

- **Resequence, don't redesign.** Restate the existing Phase 1-4 tickets in
  dependency order against what's actually landed today (see Staged plan
  below), so the next agent picking this up executes ticket N+1, not ticket 1
  again.
- **Add one finding: BYO model access has a faster path than Phase 3.3-3.4
  implies.** `account_connections` (encrypted per-user provider credentials,
  OAuth + API key + PAT + service account kinds) already exists and is
  unused by the inference call path. Wiring the existing LLM call sites to
  check it before falling back to the operator's env key is smaller than
  building the `virtual_key` routing layer first, ships BYOK/BYO-subscription
  sooner, and does not conflict with `virtual_key` landing later (budget and
  routing policy layer on top of the same credential resolution).
- **Add one constraint: fix the deploy pipeline first, or in parallel, not
  after.** Per `m4-promotion-plane-blocker`, VPS auto-deploy has been dead
  since deploy-hardening landed and master is 30+ commits ahead of the
  running `vps-deploy` ref. None of the tickets below reach real users
  without this fixed. This is explicitly out of this change's scope (it is
  gateway-deploy-lane work, not platform/auth/billing work) but is recorded
  here as a hard precondition for Phase 5/6 (hosted deployment topology,
  self-host provisioning) and for shipping auth/billing to a real user at all.
- **Answer the "split the droplet" question the original change deferred.**
  Not yet. See the assessment doc section 3 ("Should the droplet be split?").
  One image with internal module boundaries remains correct; the trigger to
  revisit is real multi-tenant contention evidence or a specific compliance
  requirement for network/process isolation, neither of which exists today.

## Non-Goals

- No new user decisions. The five 2026-07-04 decisions stand.
- No implementation in this change. This is sequencing and one new spec
  requirement (BYO credential resolution order); tickets are for follow-on
  implementation changes.
- No droplet split, no new deployed service, no microservice extraction.
- No live Stripe integration (unchanged from the parent change's non-goals).
- Does not fix the deploy pipeline itself — that's a separate, already-known
  blocker (`m4-promotion-plane-blocker`) owned by the deploy/verify lane.

## Impact

- Adds one ADDED requirement (BYO credential resolution order) to a new
  `hosted-product-platform` spec capability, layered on top of
  `production-grade-hosted-product`'s existing spec deltas rather than
  duplicating them.
- No code changes in this change.
- Downstream: the next agent executing Phase 2/3 tickets should read the
  Staged plan in `tasks.md` here for order, and the assessment doc for why.
