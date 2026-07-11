# Contract M3-R6: decide context before retrieval and answer

## Status and architecture decision

This is a targeted repair contract for the R6 audit block. It selects a
**dedicated decision preflight followed by a correctly scoped answer call**.
The preflight is a model tool round, not an answer round. It receives the user
turn and bounded routing instructions, but no caller-thread retrieval. After
the gateway applies the existing deterministic gates, it builds the canonical
artifact for the resolved action and only then starts the answer/tool loop.

This decision is required by the product contract, not left to the implementer.
The current specifications jointly require all of the following:

- the model may override a deterministic `continue` prior with `new` or `fork`;
- the decision occurs before answering;
- `new` and `incognito` are cold except for standing facts; and
- the canonical artifact exists before the answer provider call.

The current combined decision/answer loop cannot satisfy those requirements:
the first model round already receives caller-branch retrieval before the model
can choose a different scope. Restricting model overrides would contradict the
explicit override scenarios. Merely replacing context after the tool handler
would not retract context already disclosed to the provider. A dynamic
replacement loop is acceptable only if its first round is semantically the
context-free preflight specified here and its answer phase starts a new provider
request with a newly assembled message list; that is the same architecture and
must not be represented as a single context-bearing call.

The phrase “via one `context_management` tool call” is interpreted as exactly
one decision-tool invocation per eligible turn, not one total provider request.
If product ownership instead means one total provider request, the OpenSpec is
unsatisfiable with model-selected cold branches and must be escalated rather
than weakened in code.

## Exact objective and non-negotiables

For text chat and cascaded voice, resolve `continue`, `new`, `fork`, or
`incognito` before any provider request can observe branch retrieval or produce
answer text. Build the answer artifact from the resolved scope. For the legacy
HTTP voice path, which has no model decision tool, resolve its deterministic
effective action before artifact assembly. Preserve provider-independent
behavior, explicit-client precedence, the incognito-warrant gate, fail-soft
answers, fork continuity, bounded artifacts, and existing persistence rules.

Non-negotiable invariants:

1. A decision preflight receives no standing facts, recency, semantic recall,
   operational context, screen context, browser evidence, run/task content, or
   previous messages. It may receive only the current user text, the bounded
   context-action vocabulary/instruction, and non-content routing metadata
   already required by the provider adapter.
2. A preflight must not emit user-visible text, streaming deltas, TTS input,
   tool acknowledgements, profile writes, browser/phone actions, or any tool
   other than `context_management`.
3. An explicit valid client `context_action` skips the model preflight and is
   resolved directly. The answer provider still receives the corresponding
   artifact.
4. Without an explicit client action, the preflight forces or requires exactly
   one `context_management` tool call. Unsupported tools, timeout, malformed
   output, or provider failure returns the deterministic prior; it must not run
   a plain-answer fallback during preflight and must not fail the turn.
5. Apply `resolveContextDecision` after the preflight. The client-wins and
   incognito-warrant gates remain authoritative gateway code; model output is a
   proposal.
6. Use `decision.retrieval_query` when nonblank, otherwise the current user
   text, as the canonical artifact query. The receipt/cache identity must
   describe that actual query without exposing it.
7. Artifact scope by final action is exact:
   - `continue`: standing facts plus caller-branch recency, fork inheritance
     when the caller is already a fork, semantic recall, and scoped operational
     sources;
   - `fork`: standing facts plus the parent caller branch up to the captured
     fork point and the new child’s own (initially empty) history, plus recall
     allowed by that lineage;
   - `new`: standing facts only; no caller recency, caller semantic summaries,
     runs, tasks, or operational content;
   - `incognito`: standing facts only; no caller recency, caller semantic
     summaries, runs, tasks, operational content, or persistence.
8. The resolved branch/fork point used for retrieval and the branch used to
   file the turn must be the same immutable decision result. Do not decide
   twice. Avoid durable branch/thread mutations until the answer succeeds or
   preserve the current documented failure semantics with an explicit test;
   incognito must remain wholly ephemeral.
9. The answer tool loop must not offer `context_management` again. All other
   existing, surface-appropriate profile/action tools retain their behavior.
10. Chat and cascaded voice must share the same orchestration primitive. HTTP
    voice may use its deterministic prior but must use the same artifact-scope
    builder. Streaming cascaded voice starts streaming answer text only after
    the preflight and artifact assembly finish.
11. Screen context is answer evidence, never decision-preflight input. It is
    included only in the final answer message list and remains subject to its
    existing evidence-not-instruction boundary.
12. No provider memory authority, vector database, tenant/auth redesign,
    destructive migration, live provider call, preview, restart, or deployment.

## Owned files and responsibility boundary

The repair implementer owns only:

- `gateway/server.js`
- `gateway/lib/context-decision.js` if a pure orchestration/result helper is
  necessary
- `gateway/lib/context-artifact.js` only for an explicit standing-only scope
  selector or resolved-scope input
- `gateway/test/context-artifact.test.js`
- `gateway/scripts/smoke-context-artifact.js`
- `gateway/scripts/smoke-context-decision.js`
- narrowly necessary new focused tests under `gateway/test/`
- `ARCHITECTURE.md`
- `reference/openspec/changes/context-thread-management/**`
- `reference/openspec/changes/provider-agnostic-voice-agent-runtime/specs/cache-friendly-turn-context/spec.md`
- this manager lane’s claims/merge/audit records

Do not touch Android, browser extension, billing, telemetry, deployment-control,
companion, storage schema, provider packages outside `gateway/server.js`, or
unrelated gateway routes. If correctness requires those areas, stop and request
a revised cross-lane contract.

Branch: `agent/m3-durable-context-retrieval`

Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/m3-durable-context-retrieval`

## Required interfaces and state shape

Implement one shared orchestration seam with behavior equivalent to:

```text
prepareContextDecision({
  text,
  contextAction,
  profile,
  surface,
  providerCall
}) -> {
  decision,                 // final resolveContextDecision record
  preflight: {
    attempted,
    tool_called,
    fallback_reason         // categorical/bounded; no raw provider payload
  }
}

resolveContextScope({
  sessionId,
  callerBranchId,
  surface,
  deviceId,
  decision
}) -> {
  thread,                   // immutable filing identity/lineage
  artifact_scope: {
    mode,                   // continued | fork_lineage | standing_only
    branch_id,
    inherit_from
  }
}
```

Names may follow repository style, but the two phases and their returned facts
must remain explicit and testable. Do not hide the preflight in artifact code.
Do not let the artifact builder infer a new decision from text. Prefer a pure
scope plan and one later commit/touch operation over mutating thread state in
multiple helpers.

Provider-loop support may add a narrowly typed mode equivalent to:

```text
{
  required_tool_name: "context_management",
  stop_after_first_tool: true,
  plain_reply_fallback: false,
  on_text_delta: null
}
```

It must reject/ignore any non-decision tool and discard any model text. Do not
pass the ordinary multi-tool definition set into this mode.

The response `context` block retains the existing decision fields and artifact
receipt. It may add bounded categorical preflight evidence, but must not expose
raw prompts, retrieval query, provider output, secrets, or hidden source text.

## Expected behavior and edge cases

- Explicit `new`/`incognito` never invokes a model preflight and never exposes
  caller recency to the answer provider.
- Ambiguous text whose deterministic prior is `continue` but whose forced model
  tool chooses `new` gets a standing-only answer artifact and is filed on that
  exact new branch.
- A model-selected `fork` receives only the parent lineage allowed through the
  captured fork point, never later parent turns or unrelated branches.
- A model-selected `incognito` without a warrant is denied before artifact
  assembly; the resulting prior scope is used. With a warrant, the answer sees
  standing facts only and nothing is persisted.
- A provider that does not support tools, returns answer text without the
  required tool, emits an unknown tool, emits multiple decision calls, times
  out, or returns malformed arguments falls back once to the deterministic
  prior without an extra plain-answer call. The normal answer call still runs.
- Local utility replies must use the deterministic decision before choosing
  scope and persistence; they need no model preflight. They must not claim a
  model decision occurred.
- Cascaded streaming emits no preflight text/audio. First answer delta and TTS
  text arise only from the correctly scoped answer phase.
- HTTP voice explicit/deterministic `new` and `incognito` build standing-only
  artifacts rather than caller-branch artifacts. Its current deliberate
  restriction of phrasing-only `new`/`fork` to `continue` must be documented and
  tested; changing that policy is outside this repair.
- Artifact construction failure remains fail-soft but must not fall back to
  caller-history strings for a resolved `new` or `incognito` action. Safe
  fallback for those actions is standing facts only or no retrieval.
- Retry/idempotency paths must not perform a second preflight after a completed
  response already exists, and must not mint a different branch for the same
  stored turn.

## Forbidden shortcuts

- Do not keep the existing caller-context first round and call later context
  “replacement”; disclosure already occurred.
- Do not disable model `new`/`fork` overrides, require explicit UI actions for
  them, or reinterpret every ambiguous turn as `continue`.
- Do not send standing facts or screen context to the preflight “for better
  classification.”
- Do not use prompt wording alone to request a tool; enforce the required-tool
  behavior at the provider request/adaptor boundary and test both OpenAI and
  Vertex payload shapes.
- Do not reuse preflight-generated prose as the answer.
- Do not offer mutation/action tools during preflight.
- Do not build both caller and resolved artifacts and choose later; avoid the
  privacy exposure and wasted traversal.
- Do not fabricate measured latency, cost, privacy, or provider-compatibility
  results. No paid/live provider call is authorized by this contract.
- Do not loosen existing context bounds, redaction, authorization, branch
  provenance, cache identity, complexity, or CRAP gates to make tests pass.
- Do not edit or deploy from the active application tree.

## Quality, complexity, performance, and resource targets

- Preserve `gateway/lib/context-artifact.js` function complexity <= 10 and CRAP
  <= 15 under the checked-in quality gate.
- New orchestration functions target complexity <= 10 and no function over 60
  logical lines; if the existing `server.js` loop makes this impossible, extract
  a pure helper under `gateway/lib/` and add it to owned files in the repair
  note before editing.
- Exactly one preflight provider request is allowed when no explicit client
  action exists and a decision-capable provider is configured. Explicit-client,
  local-utility, unsupported-provider, and stored-idempotent-response paths must
  not create avoidable preflight calls.
- Exactly one canonical artifact is built per answer attempt. Preflight performs
  no artifact/source traversal.
- Preflight input must be bounded by the existing turn-text limit plus a fixed
  decision instruction; preflight output fields retain the current action,
  query, label, and reason bounds.
- This architecture adds a serial decision round to undecided turns. It is a
  known latency/cost tradeoff, not a measured regression. Do not assert a
  latency budget until deterministic timing instrumentation and paid/live
  provider samples exist.

## Required tests and acceptance gates

Add deterministic hostile tests that capture provider request payloads rather
than trusting response receipts alone:

1. Chat, model override `continue -> new`: first request contains current turn
   and decision schema only; it contains a unique secret-like sentinel from
   neither caller recency nor standing facts. Second request contains standing
   facts but not caller-recency/semantic/operational sentinels. Filing branch and
   receipt are the same new branch.
2. Chat, model override `continue -> fork`: second request contains allowed
   parent turns only through the captured fork point and excludes a later-turn
   sentinel.
3. Chat, warranted `incognito`: preflight and answer requests exclude caller
   context; answer may contain a standing-fact sentinel; persistence stores,
   events, summaries, broker records, and artifacts remain empty for the turn.
4. Chat, unwarranted model `incognito`: gateway denies it before assembly and
   builds the deterministic-prior scope.
5. Explicit client `new`, `incognito`, and `continue`: no preflight request;
   answer scope is exact and a conflicting model decision is impossible because
   `context_management` is absent from answer tools.
6. Preflight failure matrix: unsupported tools, no tool call, malformed args,
   unknown tool, duplicate tool call, timeout/throw. Each uses the prior, emits
   no preflight text, performs no preflight plain-answer fallback, and completes
   the normal answer.
7. Mutation attack: a preflight attempts a profile/action/browser/phone tool;
   it is not offered or executed.
8. Cascaded voice (streaming and non-streaming), model-selected `new` and
   warranted `incognito`: no delta/TTS callback before the answer phase; captured
   answer payload is standing-only; final receipt and persistence are correct.
9. HTTP voice explicit `new` and warranted/explicit `incognito`: captured answer
   payload is standing-only. A phrasing-only `new` remains the documented
   deterministic `continue` behavior.
10. Retry of an already completed turn returns the stored response without a
    preflight call or new branch.
11. Artifact-build failure on `new`/`incognito` never injects legacy caller
    history.
12. Both OpenAI-compatible and Vertex request-shape fixtures prove required-tool
    enforcement and absence of retrieval/system evidence in preflight.

Acceptance commands, all required:

```sh
cd gateway && node scripts/smoke-context-decision.js
cd gateway && node scripts/smoke-context-artifact.js
cd gateway && npm run check:context-quality
cd gateway && npm run check
npx --yes @fission-ai/openspec@latest validate context-thread-management --strict
npx --yes @fission-ai/openspec@latest validate provider-agnostic-voice-agent-runtime --strict
```

If the repository’s initialized OpenSpec command differs, use that command and
record the exact invocation/output. Network-fetched CLI execution is not proof
unless the package/version and output are retained.

After gates pass, run fresh independent auditors for:

- goal correctness and cross-surface consistency;
- privacy/security and incognito trust boundaries;
- latency/cost/resource behavior;
- complexity/CRAP and maintainability; and
- anti-gaming (payload-capture coverage, forced-tool enforcement, no disguised
  caller-context first round).

Auditors must return `PASS` or `BLOCK` with file:line evidence and a claims
ledger. Any `BLOCK` creates another focused repair contract before code changes.

## Audit blockers and escalation criteria

Block implementation and return to the parent manager if any of these is true:

- Product ownership states “one tool call” means one total provider request.
  That contradicts model-selected cold context; require an explicit spec change
  choosing either restricted overrides or two-phase calls.
- The product requires model-selected context routing on the legacy HTTP voice
  path. That would add a new model call and behavior outside this repair.
- The provider adapters cannot enforce a required tool without exposing caller
  context or accepting prose as a decision.
- A new/fork branch must be durably minted before the answer, but current
  failure semantics forbid abandoned empty branches and no reversible staging
  mechanism exists.
- Correctness requires changes in Android, browser extension, provider package,
  schema, tenant authority, billing, deployment, or other owned lanes.
- Existing specs require caller recency for `new` or `incognito`, or prohibit
  standing facts for those actions. Cite the exact conflicting lines and do not
  invent a compromise.
- Any required deterministic gate fails for a reason outside owned paths.

## Confidence and residual unknowns

### Measured results

None were produced by writing this contract. The R6 audit packet reports prior
local results (focused 17/17; complexity maximum 10; CRAP 11.896296; full
gateway 189 pass, 1 skip, 0 fail), but those measurements cover the pre-repair
implementation and do not validate this architecture. No paid benchmark,
external evaluation, provider call, preview, or deployment was run.

### Architecture-confidence assessment

**Target: high, currently moderate until implementation and hostile tests.**

Evidence supporting the choice:

- a context-free first request makes non-disclosure inspectable in captured
  provider payloads;
- the existing pure `resolveContextDecision` retains client precedence and the
  incognito double gate;
- a fresh answer request prevents already-disclosed caller context from
  influencing cold-thread answers;
- one shared scope plan can align chat, cascaded voice, and deterministic HTTP
  voice; and
- the existing artifact receipt/cache machinery can describe the actual
  resolved query and sources without a new store.

Residual unknowns:

- real provider adherence and exact required-tool behavior across configured
  OpenAI-compatible vendors and Vertex;
- added first-answer/first-audio latency and token cost under production models;
- classification quality when preflight receives only the current turn;
- operational behavior on provider timeouts and reconnects;
- real Android/browser user perception; and
- whether product ownership accepts the two-provider-request interpretation of
  one decision tool call.

These are not benchmark results. Close deterministic unknowns with fixtures and
fault injection; close latency, cost, provider, and UX unknowns only with
retained paid/live measurements and device QA under separately authorized gates.
