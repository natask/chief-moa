# Hard repair contract

## Objective and non-negotiables

Wire M6 and MB source seams into explicit runtime authority without silently
inventing marketplace, payment, pricing, tax, refund or provider policy. Trust,
license, moderation, protocol, entitlement, price and budget facts come only
from a trusted constructor/configuration boundary and default to deny.

## Ownership

Own `gateway/lib/runtime-authority.js`, focused tests, narrowly required
`gateway/server.js` route wiring, package scripts, architecture/OpenSpec deltas,
and this packet. Do not modify deployment adapters, clients, provider SDKs or
active data. Work only on `agent/runtime-authority-final-repair`.

## Required behavior

- Import and preview accept only a bounded M6 envelope verified against a
  caller-owned trust/license/moderation/revocation/protocol policy.
- Apply requires the exact preview/package/profile-version/scope binding and a
  fresh bounded approval. The profile authority must return before/after
  versions and a durable receipt. Retries return the same effect result.
- Rollback requires the exact applied-effect binding, restores the captured
  prior state through the profile authority and records a chained receipt.
- Legacy catalog identifiers, unsigned manifests and caller-supplied trust
  roots cannot reach a profile mutation.
- Billing runtime authorization is tenant-owned, requires the latest active
  entitlement, atomically reserves against an immutable budget version, and
  records usage against an immutable price version. Sandbox effects remain
  `charged:false`; webhook evidence never directly changes entitlement.

## Forbidden shortcuts and targets

No trust-on-first-use, body-supplied public key/policy, default license,
unverified legacy apply, model payment mutation, floats, caller-raised budget,
real charge, retry loop, shell, network I/O or fake-live claim. Decision
complexity target <=10 and CRAP <=15. Inputs and receipts remain bounded.

## Gates and escalation

Run `node --test test/runtime-authority.test.js`, source syntax checks and
`npm run check`; hostile security, resource, quality, complexity, anti-gaming
and adjacent-integration audit must PASS. Escalate rather than invent public
trust/moderation, commercial policy, tenant authentication or live provider
configuration.
