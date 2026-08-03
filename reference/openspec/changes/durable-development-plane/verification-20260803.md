# Durable development plane verification — 2026-08-03

## Candidate scope

- Preserve one raw development riff, task graph, task receipts, QA evidence,
  frozen candidate, and exact user decision on the existing event substrate.
- Dispatch dependency-safe work only through queued worker-pull runs and keep
  integration authority serial across intents.
- Serve a separate authenticated development/QA surface without granting
  merge, publish, or deployment authority.
- Preserve non-default isolated preview launch settings through launchd.

## Automated evidence

- `cd gateway && pnpm install --frozen-lockfile` passed without lockfile drift.
- `cd gateway && npm run check` passed, including the gateway coverage gates.
- The five focused development-plane test files passed with 18 tests.
- `node scripts/source-size-policy.js` passed.
- `openspec validate durable-development-plane --strict` passed.
- `bash -n scripts/preview/gateway-lan.sh` and `git diff --check` passed.

## Isolated preview evidence

The candidate ran through `scripts/preview/gateway-lan.sh` with port `8798`
and root `/private/tmp/chief-moa-gateway-preview-8798`, separate from the active
gateway and from the existing development preview. The script preserved those
values through launchd and removed the service cleanly on stop.

- Health returned the candidate build identity and `drain_safe=true`.
- An unauthenticated protected route returned `401`.
- A real Vertex model turn returned the requested `preview ready` marker.
- An authenticated development intent create/read round trip returned the exact
  riff from the isolated event store at version 1.

## Release posture

The state additions are new event types and predecessor-readable records. The
development plane does not mutate the active checkout, merge a candidate, or
promote a release. Production promotion may proceed through the existing
gateway preview, drain, compatibility, rollback, and exact-health gates.
