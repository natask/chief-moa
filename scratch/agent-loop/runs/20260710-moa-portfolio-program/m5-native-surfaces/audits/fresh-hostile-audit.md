# Fresh hostile audit — M5 Aggie surface protocol

Status: BLOCK
Date: 2026-07-10
Auditor posture: hostile, source-only, no native inference

## Scope read

- `AGENTS.md`
- `README.md`
- `ARCHITECTURE.md`
- `AGENT_WORKFLOW.md`
- `reference/openspec/changes/define-aggie-compatible-surface/{proposal.md,design.md,tasks.md,specs/aggie-surface-protocol/spec.md}`
- `scratch/agent-loop/runs/20260710-moa-portfolio-program/m5-native-surfaces/{goal.md,contracts/implementation-contract.md}`
- `gateway/lib/aggie-surface-protocol.js`
- `gateway/test/aggie-surface-protocol.test.js`
- `gateway/scripts/smoke-aggie-surface-protocol.js`
- current diff

## Measured evidence

- PASS: focused unit test passes.
  Evidence: `cd gateway && node --test test/aggie-surface-protocol.test.js`
- PASS: focused smoke passes.
  Evidence: `cd gateway && node scripts/smoke-aggie-surface-protocol.js`
- BLOCK: full gateway check is not green in this environment, so goal acceptance 6 is not met as written.
  Evidence: `cd gateway && npm run check`
  Result: exits 1 with many `listen EPERM: operation not permitted 127.0.0.1` failures in `test/smoke-unit.test.js` and one `voice-text-turn` failure from the same bind restriction. This is measured, but not attributable to the M5 diff alone.

## Findings

### BLOCK 1: `canExecuteProposal()` accepts any approved object with a matching `proposal_id`, even when the approval is from a different session/surface

- Spec requires explicit approval tied to local authority: [spec.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/reference/openspec/changes/define-aggie-compatible-surface/specs/aggie-surface-protocol/spec.md:37) through [spec.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/reference/openspec/changes/define-aggie-compatible-surface/specs/aggie-surface-protocol/spec.md:43)
- Goal forbids unapproved local execution: [goal.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/scratch/agent-loop/runs/20260710-moa-portfolio-program/m5-native-surfaces/goal.md:40)
- Contract forbids implicit action approval: [implementation-contract.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/scratch/agent-loop/runs/20260710-moa-portfolio-program/m5-native-surfaces/contracts/implementation-contract.md:35) through [implementation-contract.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/scratch/agent-loop/runs/20260710-moa-portfolio-program/m5-native-surfaces/contracts/implementation-contract.md:37)
- Implementation only checks `proposal_id` and `decision`, not approval scope or freshness: [aggie-surface-protocol.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/gateway/lib/aggie-surface-protocol.js:152) through [aggie-surface-protocol.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/gateway/lib/aggie-surface-protocol.js:167)
- Tests currently encode the unsafe behavior as success: [aggie-surface-protocol.test.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/gateway/test/aggie-surface-protocol.test.js:52) through [aggie-surface-protocol.test.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/gateway/test/aggie-surface-protocol.test.js:59)

Reproduction:

```sh
cd gateway && node - <<'NODE'
const { canExecuteProposal } = require('./lib/aggie-surface-protocol');
const proposal = {
  version: 2,
  type: 'action.proposed',
  message_id: 'proposal_message_1',
  session_id: 'sess_1',
  surface: { id: 'moa-browser', kind: 'browser', mode: 'text', device_id: 'dev_1' },
  timestamp: '2026-07-10T12:00:00.000Z',
  payload: {
    proposal_id: 'proposal_1',
    kind: 'open_url',
    approval_class: 'confirm',
    expires_at: '2026-07-10T12:01:00.000Z',
    preconditions: { active_tab: 'tab_1' },
    params: { url: 'https://example.com' },
  },
};
console.log(canExecuteProposal(proposal, {
  now: '2026-07-10T12:00:00.000Z',
  session_id: 'sess_1',
  surface_id: 'moa-browser',
  state: { active_tab: 'tab_1' },
  approval: {
    proposal_id: 'proposal_1',
    decision: 'approved',
    actor_id: 'someone-else',
    decided_at: '2020-01-01T00:00:00.000Z',
    session_id: 'sess_other',
    surface_id: 'other-surface'
  }
}));
NODE
```

Observed output:

```json
{"allowed":true,"reason":"eligible"}
```

Impact:

- A caller can satisfy approval with an unrelated approval-shaped object.
- The trust boundary described in `ARCHITECTURE.md` is overstated for this seam: [ARCHITECTURE.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/ARCHITECTURE.md:116) through [ARCHITECTURE.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/ARCHITECTURE.md:122)

Repair:

- Require `context.approval` to be a validated approval envelope or validated approval record bound to `proposal_id`, `session_id`, `surface.id`, and a bounded approval timestamp.
- Add negative tests for mismatched session, mismatched surface, stale approval, and missing actor metadata.

### BLOCK 2: hello/resume semantics are not actually validated, so malformed handshake payloads are accepted as canonical envelopes

- Goal acceptance says typed envelopes must cover hello/resume with exact bounds: [goal.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/scratch/agent-loop/runs/20260710-moa-portfolio-program/m5-native-surfaces/goal.md:34) through [goal.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/scratch/agent-loop/runs/20260710-moa-portfolio-program/m5-native-surfaces/goal.md:37)
- Spec says unsupported versions or unsupported semantics must be rejected: [spec.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/reference/openspec/changes/define-aggie-compatible-surface/specs/aggie-surface-protocol/spec.md:7) through [spec.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/reference/openspec/changes/define-aggie-compatible-surface/specs/aggie-surface-protocol/spec.md:21)
- Contract says `validateEnvelope()` normalizes and validates surface messages for protocol versions 1 and 2: [implementation-contract.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/scratch/agent-loop/runs/20260710-moa-portfolio-program/m5-native-surfaces/contracts/implementation-contract.md:5) through [implementation-contract.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/scratch/agent-loop/runs/20260710-moa-portfolio-program/m5-native-surfaces/contracts/implementation-contract.md:19)
- Implementation validates typed payloads only for `turn.text`, `action.proposed`, `action.approved`, `action.receipted`, and `artifact.created`; `hello` and `resume` fall through to generic JSON acceptance: [aggie-surface-protocol.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/gateway/lib/aggie-surface-protocol.js:55) through [aggie-surface-protocol.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/gateway/lib/aggie-surface-protocol.js:60)
- Tests do not cover `hello` or `resume` payload semantics at all: [aggie-surface-protocol.test.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/gateway/test/aggie-surface-protocol.test.js:26) through [aggie-surface-protocol.test.js](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/gateway/test/aggie-surface-protocol.test.js:99)

Reproduction:

```sh
cd gateway && node - <<'NODE'
const { validateEnvelope } = require('./lib/aggie-surface-protocol');
console.log(JSON.stringify(validateEnvelope({
  version: 2,
  type: 'hello',
  message_id: 'msg_hello_1',
  session_id: 'sess_1',
  surface: { id: 'moa-browser', kind: 'browser', mode: 'event' },
  timestamp: '2026-07-10T12:00:00.000Z',
  payload: { supported_versions: 'not-an-array', resume_cursor: { bad: true } }
})));
NODE
```

Observed output:

```json
{"version":2,"type":"hello","message_id":"msg_hello_1","session_id":"sess_1","surface":{"id":"moa-browser","kind":"browser","mode":"event"},"timestamp":"2026-07-10T12:00:00.000Z","payload":{"supported_versions":"not-an-array","resume_cursor":{"bad":true}}}
```

Impact:

- The code claims N/N-1 handshake coverage, but malformed hello data survives canonicalization.
- “Unknown additive fields are ignored” is implemented, but “unknown required semantics fail closed” is not proven for hello/resume.
- The architecture note “bounded typed envelopes for turns, events, action proposals, approvals and local receipts” is directionally true for the subset implemented, not for the handshake/resume seam as claimed: [ARCHITECTURE.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/ARCHITECTURE.md:109) through [ARCHITECTURE.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/ARCHITECTURE.md:114)

Repair:

- Add typed validators for `hello`, `hello.accepted`, `resume`, `run.*`, `route.selected`, and `message.created` payloads instead of generic JSON pass-through.
- Make `validateEnvelope()` and `negotiateVersion()` operate on the same validated hello shape.
- Add N/N-1 tests that reject malformed `supported_versions`, malformed replay cursors, and semantic omissions.

## Category assessment

- Correctness: BLOCK. Core approval and hello/resume invariants are incomplete.
- Security/trust: BLOCK. Approval scope can be spoofed by caller-supplied context.
- Performance/resources: PASS with measured limits only. Envelope, replay, pending, and reconnect bounds are implemented and exercised in focused tests.
- Quality: BLOCK. Test coverage omits the handshake/resume seam and currently asserts an unsafe approval success path.
- Complexity/CRAP: PASS with caution. Functions are small, but semantic coverage is partial.
- Anti-gaming: BLOCK. The slice marks protocol fixtures done in tasks, but key handshake semantics are still generic pass-through: [tasks.md](/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol/reference/openspec/changes/define-aggie-compatible-surface/tasks.md:50)
- UX/accessibility implications: confidence only, not measured. Reject/fail-closed paths exist for stale state and approval-required, but no native/browser UX evidence was provided in this slice.
- Adjacent integration: BLOCK on acceptance gate only. `npm run check` is not green in this environment; I did not infer product breakage beyond the measured bind restriction.

## Claims ledger

- Claim: deterministic echo adapter exists and avoids external I/O.
  Measured: PASS via focused test and smoke; code is in-memory only.
- Claim: replay/dedupe, cursor eviction, and reconnect bounds are deterministic.
  Measured: PASS for the implemented `createSessionReplay()` and `reconnectDelay()` subset.
- Claim: typed N/N-1 envelopes cover hello/resume, turns, events, proposals, approvals, and receipts.
  Measured: BLOCK. hello/resume and several event payloads are not typed/validated.
- Claim: unapproved local execution is structurally excluded.
  Measured: BLOCK. `canExecuteProposal()` accepts unrelated approval-shaped context.
- Claim: full gateway check passes.
  Measured: BLOCK in this environment due `EPERM` localhost bind failures; not enough evidence to attribute to this diff.
- Claim: native/browser behavior is proven.
  Confidence: no evidence. This slice explicitly does not include native proof, and I infer nothing beyond source text.

## Repairs

1. Tighten `canExecuteProposal()` to require a validated approval object/envelope bound to the same proposal, session, surface, and bounded time window.
2. Add typed payload validators for hello/resume and the remaining event families instead of `validateDataPayload()` pass-through.
3. Replace the current positive approval test with hostile negative cases for mismatched approval provenance.
4. Add hostile hello/resume tests for malformed `supported_versions`, malformed cursor state, and missing required semantics.
5. Re-run the focused protocol test/smoke and the full gateway check in an environment that permits the existing smoke bind behavior, or explicitly narrow acceptance 6 if that repo-wide gate is intentionally out of scope.

## Confidence boundary

- Measured directly: protocol unit test, protocol smoke, the two reproductions above, and the repo-wide `npm run check` result in this sandbox.
- Architecture confidence only: Android/browser UX, local executor safety beyond this module, secure storage, signing, update behavior, and any live/native session continuity.

VERDICT: BLOCK
