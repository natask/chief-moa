# Implementation contract: voice reliability and diagnostics

## Objective

Make silent or degraded voice turns locally diagnosable and deterministically
testable while preserving existing profile, sampler, provider, and client trust
boundaries. Add browser sampler parity only if the product action contract can
be consumed without broadening authority.

## Parent and inputs

- Parent goal: `../goal_moa_portfolio_program.md`
- Required specs: `reference/openspec/changes/provider-agnostic-voice-agent-runtime`
  and `reference/openspec/changes/streaming-cascaded-voice`
- Prior notes: `scratch/agent-loop/voice-pipeline-e2e/`
- Architecture: `ARCHITECTURE.md`

## Lane and ownership

- Branch: `agent/voice-reliability-diagnostics`
- Worktree: isolated sibling worktree created from the selected clean base.
- Primary responsibility: gateway voice phase diagnostics, deterministic fault
  injection, local read API, spec reconciliation, and narrowly required client
  sampler consumption.
- Do not touch deployment scripts, authentication architecture, unrelated
  browser actions, native desktop code, or active data.

Exact file ownership must be finalized by the contractor after reconciling
current source and in-flight branches. Expected areas are:

- `gateway/lib/voice-session-server.js`
- `gateway/lib/voice-providers.js`
- a narrow new or existing gateway diagnostics module
- focused gateway smoke/tests and `gateway/package.json`
- the two voice OpenSpec task files
- browser sampler consumer files only if the action is currently unhandled

If ownership conflicts or repo reality contradicts this list, block and return
to the parent manager; do not silently redesign.

## Required behavior

- Normalize voice outcomes to bounded phases: capture, transport, STT, context,
  reasoning, TTS, playback, and storage.
- Persist/query enough local evidence to answer why a turn was silent without a
  provider console. Responses must redact secrets and respect retention policy.
- Preserve existing `first_audio_ms`, `tts_segments`, `tts_spoke`, and
  `tts_error`; do not replace more specific evidence with a generic status.
- Visible text fallback must remain available when TTS degrades.
- Fault-injection tests must prove at least reasoner, TTS, and storage failures
  are attributed to the correct phase; contractor must specify how client-only
  capture/playback phases are represented without fabricating server knowledge.
- Long multi-segment audio must remain ordered under bounded concurrency.
- Voice sampling must use session-only overrides and must not mutate the saved
  profile. Browser parity, if added, consumes the same bounded action.
- Persisted voice changes remain reversible and apply at the documented boundary.
- Define requested voice changes during an answer as next-segment or
  next-utterance behavior; already emitted audio is never rewritten.

## Forbidden shortcuts

- No live/paid result inferred from mocks, loopback, architecture, or unit tests.
- No provider keys, raw transcripts beyond retention policy, or secrets in logs.
- No weakening of browser/Android local authority.
- No arbitrary CSS/JS/shell/action fields.
- No test that passes merely because text was generated when audio was required.
- No checkbox-only OpenSpec reconciliation; cite code and runnable evidence.
- No deployment from a dirty tree and no restart of an active voice service.

## Quality and resource targets

- New decision logic should remain small and single-purpose; contractor records
  cyclomatic complexity and CRAP evidence for materially changed functions.
- Diagnostic writes are bounded per turn and do not retain duplicate raw audio.
- Diagnostic reads are token protected, paginated/bounded, and do not scan
  unbounded history.
- No unbounded retry, queue, event, or audio-buffer growth.
- Mutation/fault tests must demonstrate that the primary negative-path assertions
  fail when attribution/fallback behavior is removed.

## Acceptance commands

```sh
cd gateway && npm run check
cd gateway && node scripts/smoke-voice-profile.js
cd gateway && node scripts/smoke-cascaded-voice.js
cd gateway && node scripts/test-voice-chunker.js
cd browser_extension && npm run verify && npm run smoke
cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug
openspec validate provider-agnostic-voice-agent-runtime --strict
openspec validate streaming-cascaded-voice --strict
```

The contractor must add exact focused commands for the new diagnosis and fault
matrix. Live provider and real-phone QA are recorded separately as `NOT
MEASURED` until executed with environment, sample count, timestamp, commit, and
raw evidence.

## Audit blockers and escalation

Block for: incompatible in-flight ownership; missing retention/redaction policy;
diagnostics requiring active-data mutation; inability to distinguish server
evidence from client inference; sampler requiring broader action authority;
failing pre-existing gates; or any promotion requirement lacking preview,
rollback, no-interruption, compatibility, backup, or restore evidence.
