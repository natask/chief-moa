# Behavior-preservation baseline for semantic reduction

## Decision rule

Production implementation code is the reduction metric. Test code is unrestricted and is reported separately. A reduction is acceptable only when the protected behavior scorecard is equal or better, the relevant deterministic tiers pass, and any intentional contract change is separately approved. Passing a lower tier cannot substitute for a feasible higher-tier check.

This report is evidence, not permission to exercise paid providers, production state, real recordings, browser reload, device install, or deployment.

## Reproducible semantic LOC

Use tracked files only and `scc 3.7.0`, which excludes blank and comment-only lines from `Code`. Classification precedence is test, generated, docs, config, production, other. In zsh from the repository root:

```zsh
classify() {
  local category=$1 p c files=()
  while IFS= read -r p; do
    if [[ $p =~ '(^|/)(test|tests|scripts/smoke|scripts/test|src/test|src/androidTest)(/|$)' || $p =~ '(^|/)([^/]*[Tt]est|smoke-[^/]+)\.(js|mjs|ts|java|kt)$' ]]; then c=test
    elif [[ $p =~ '(^|/)(build|dist|generated|node_modules)(/|$)' || $p =~ '\.(lock|min\.js|map|apk|zip|pcm|png|jpg|jpeg|gif|webp|woff2?)$' ]]; then c=generated
    elif [[ $p =~ '(^|/)(reference|scratch|\.docs)(/|$)' || $p =~ '(^|/)(README|ARCHITECTURE|AGENT_WORKFLOW|AGENTS|CONTRIBUTING|ENGINEERING_STRATEGY|CHANGELOG)(\.md)?$' || $p =~ '\.(md|txt)$' ]]; then c=docs
    elif [[ $p =~ '(^|/)(package(-lock)?\.json|manifest\.json|.*\.ya?ml|.*\.toml|.*\.properties|.*\.xml|.*\.json)$' ]]; then c=config
    elif [[ $p =~ '\.(js|mjs|cjs|ts|tsx|jsx|java|kt|kts|py|sh|bash|sql|css|html)$' ]]; then c=production
    else c=other; fi
    [[ $c == $category ]] && files+=("$p")
  done < <(git ls-files)
  (( ${#files} )) && scc -f json "${files[@]}" | jq -r --arg k "$category" \
    '[$k,([.[]|.Code]|add),([.[]|.Lines]|add),([.[]|.Comment]|add),([.[]|.Blank]|add)]|@tsv'
}
for c in production test generated config docs other; do classify $c; done
```

Baseline at this branch before report commit:

| Class | Semantic code | Physical lines | Comments | Blanks | Meaning |
|---|---:|---:|---:|---:|---|
| production | 63,576 | 72,694 | 4,201 | 4,917 | reduction numerator |
| test | 27,228 | 31,530 | 1,593 | 2,709 | unrestricted safety investment |
| config | 942 | 1,106 | 75 | 89 | reported, not numerator |
| docs | 20,048 | 25,228 | 0 | 5,180 | reported, not numerator |
| generated/binary | not parsed | not parsed | not parsed | not parsed | excluded |
| other | 12,151 | 15,127 | 2 | 2,974 | inspect before claiming savings |

The earlier 90,399 number combines categories and therefore must not be used as the production reduction target. `other` must be audited once because SVG or unrecognized source may belong in production; thereafter freeze this classifier for before/after comparisons. Also report `git diff --numstat <baseline>...HEAD` by surface so vendored/generated movement cannot game the result.

## Six-level evidence hierarchy

### Level 1 — unit and contract

Pure state machines, parsers, sanitizers, schemas, trust boundaries, and wire-event shapes. Existing examples: Android `MoaVoiceFirstTapResolverTest`, `MoaSpeechTranscriptAccumulatorTest`, `MoaActionBrokerTest`, `MoaOperationalTurnRouterTest`; gateway `voice-diagnosis.test.js`, `voice-text-turn.test.js`, `smoke-voice-intent.js`, `smoke-voice-router.js`, `smoke-language-allowlist.js`, `smoke-page-tweaks.js`, voice chunker; browser voice sampler lifecycle tests. These are fast and necessary but do not prove assembled journeys.

### Level 2 — component

Real component with fake boundaries: extension under headless Chrome, Android JVM controllers, gateway voice/session/router/store modules. Existing examples: extension `npm run verify`, `npm run smoke`; gateway smoke manifest invoked by `npm run check`; Android `testDebugUnitTest`. Capture stable structured results, not screenshots alone.

### Level 3 — integration with real protocols/storage and fake paid providers

Start the real gateway on loopback with an isolated temporary `DATA_DIR`, isolated database when required, random port, fake STT/LLM/TTS sockets or loopback provider, and real HTTP/WebSocket/JSON/PCM protocols. Exercise migrations and relational storage using a disposable database. Existing candidates include `eval:voice:e2e`, `smoke:cascaded-voice`, `smoke:voice-turn-storage`, `smoke:voice-audio-storage`, `smoke:device-hub`, `smoke:page-tweak-e2e`, `smoke:chat-turns`, and integration tests. The current default check does not prove this tier in a clean worktree because dependencies are not installed and database tests are skipped without `DATABASE_URL`.

### Level 4 — end-to-end client → gateway → result/action/history

Use an isolated gateway from Level 3 and the real client runtime. Highest-order journeys are:

| Journey | Required observable outcome | Existing evidence | Highest feasible tier / gap |
|---|---|---|---|
| Android text/voice turn | capture/final transcript → authenticated gateway turn → visible reply/audio → canonical turn query | gateway voice E2E and Android controller tests | L4 missing as one automated phone/client harness |
| Browser text turn | preserve input draft; `/v1/voice/turns` or `/v1/chat`; render reply/error | `smoke:gateway`, extension smoke | L4 feasible; authenticated isolated-gateway fixture should replace live-token dependency |
| Browser voice turn | shortcut/mark capture → WS session → partial/final transcript → ordered audio/done | extension voice smoke plus gateway voice smokes | L4 fragmented; current extension smoke fails shortcut sequence |
| Phone action | gateway proposal only → Android policy/approval → local execution → receipt → history | `MoaActionBrokerTest`, `smoke:device-hub` | L4 needs emulator fake action executor and receipt query |
| Browser page tweak | bounded declarative proposal → local allowlist/compiler → applied effect; malformed proposal rejected | `smoke:page-tweak-e2e`, `smoke:tweaks` | L4 feasible; unify into one isolated journey |
| Browser agent task | proposal/claim → CDP action → observable page result → run/history | `smoke:browser-agent-routing`, extension CDP/agent-loop smokes | L4 fragmented; one deterministic fixture required |
| Persistence/resume | completed and interrupted turns, transcript source, partial context, profile version survive restart and remain queryable | session/history, turn-storage, interrupt-handoff, relational integration smokes | L3 strong candidates; L4 cross-client resume missing |
| Failure diagnosis | injected capture/transport/STT/reasoning/TTS/playback/storage faults name conservative phase and retain evidence | `voice-diagnosis.test.js`, `smoke:voice-diagnosis` | L3 required; playback/capture client faults need L4 |
| Profile/language/voice sample | versioned sanitized update/revert; next turn uses snapshot; sample never mutates saved voice | profile/language smokes and browser sampler tests | L3 fragmented; concurrency/snapshot and full client display gaps |
| Work/history intent | launch/status/cancel or query returns durable run/turn evidence | work-history, message-broker, stacked/durable routing smokes | L3; L4 client rendering missing |

Level 4 acceptance fixtures should assert durable API records after user-visible completion, not merely DOM state or status 200.

### Level 5 — sanitized runtime replay captures

Opt-in capture only. Copy a retained fixture by explicit turn ID into an offline quarantine; never enumerate or dump production conversations. Replace account/user/session/branch/turn/device IDs with deterministic aliases, strip tokens, URLs, headers, prompts, page text, contacts, filenames, raw provider payloads, and timestamps; retain consented PCM only when essential, otherwise retain derived duration/format/hash plus a synthetic audio replacement. Keep only normalized event types, ordering, phase, byte counts, transcript expectations expressed as hashes/tokens or approved fixture text, action kind/shape, result category, persistence relations, and timings. Run a secret/PII scanner, manual review, and record provenance/consent/retention. Commit only the sanitized fixture and schema; store raw capture outside Git with expiry. Replay against fake providers and isolated stores, comparing event partial order and semantic predicates rather than volatile IDs or exact prose.

Required replay set: short English and Amharic audio; partial-to-final transcript; long segmented TTS; interruption/barge-in; TTS fault with text fallback; profile change/revert; rejected unsafe action; approved fake phone action with receipt; page tweak accept/reject; cross-client resume.

### Level 6 — minimal live canaries

Run only after Levels 1–5 pass and only with explicit operator-safe conditions. One synthetic non-sensitive English voice turn and one Amharic turn; one read-only history query; optionally one no-op/rejected action proposal. Record release SHA, provider IDs (not credentials), normalized phase verdicts, first-audio latency, segment count, stored/queryable result, and cleanup. Never use real user content, mutate external systems, restart/reload an active client, or run while a recording/session/job is active. Paid-provider calls need separate authorization. Live canaries are release evidence, not the main regression suite.

## Protected behavior scorecard

Every candidate reports baseline and candidate from identical fixtures, at the highest feasible tier:

| Dimension | Required measure | Gate |
|---|---|---|
| Output correctness | normalized result type; transcript semantic predicate; visible reply; ordered audio frames | 100% protected fixtures; no lost final transcript |
| Action correctness/trust | proposal schema, policy decision, approval, executor call count, receipt relation; unsafe/malformed rejection | exact match; zero unapproved execution |
| Persistence | session/branch/turn/profile/run/action/receipt links before and after process restart | exact required fields and relations; interrupted partial retained |
| Failure diagnosis | injected phase versus reported likely phase, fallback visibility, evidence refs | 100% phase matrix; no silent terminal failure |
| Latency | capture→partial, commit→final, reasoning start, first audio, completion; p50/p95 over fixed warm runs | candidate p95 no worse than baseline by >5% or 20 ms, whichever larger; product budget still met |
| CPU | process CPU time per fixed journey and idle CPU | no >5% regression after at least 20 measured runs |
| Memory | RSS baseline, peak, post-GC/post-idle retained delta | no >5% or 10 MiB regression, whichever larger; no monotonic growth across 100 turns |
| Flake rate | failures / at least 50 deterministic repetitions, with seed and environment recorded | zero failures for merge gate; estimated rate not worse than baseline |
| Production LOC | semantic production code from frozen classifier | lower than baseline; tests reported separately and unrestricted |

Performance comparisons require the same machine, Node/JDK/Chrome versions, fixture seed, cold/warm policy, concurrency, and isolated state. Store machine-readable JSON summaries. A faster but semantically weaker candidate fails.

## Exact baseline commands

Provider-free developer gate:

```sh
(cd gateway && npm ci && npm run check && npm run eval:voice)
(cd browser_extension && npm run verify && npm run smoke)
(cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest assembleDebug)
```

Tier-3 isolated gateway gate after installing dependencies; every command must point at a fresh temporary state root and fake/loopback providers. Do not source `.env`:

```sh
(cd gateway && npm run smoke:session-history && npm run smoke:voice-turn-storage && npm run smoke:voice-diagnosis && npm run smoke:cascaded-voice && npm run smoke:voice-audio-storage && npm run smoke:live-interrupt-handoff && npm run smoke:device-hub && npm run smoke:page-tweak-e2e && npm run smoke:chat-turns && npm run smoke:work-history)
```

Disposable PostgreSQL gate (only a non-production URL created for the run):

```sh
(cd gateway && TEST_DATABASE_URL="$DISPOSABLE_DATABASE_URL" node --test test/integration/*.integration.test.js)
```

The integration tests currently check `TEST_DATABASE_URL` or `DATABASE_URL`; never supply the production URL. The reduction program should provide one wrapper that provisions and destroys the disposable database and one wrapper that enforces temporary `DATA_DIR`/random port/fake-provider settings, because invoking individual legacy smokes without reading them is not sufficient isolation evidence.

## Results captured on 2026-07-11

| Command | Result | Evidence/interpretation |
|---|---|---|
| `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest` | PASS, 6 s, 21 tasks | Android unit/contract baseline is green |
| `cd browser_extension && npm run verify` | PASS; sampler lifecycle 7/7 | manifest/static/component verification green |
| `cd browser_extension && npm run smoke` | FAIL | shortcut voice/text smoke produced an unexpected cancel/new-session sequence; Chrome also logged AudioContext autoplay warnings. Treat as a pre-existing baseline blocker, not permission to weaken assertions |
| `cd gateway && npm run check` | FAIL in clean worktree | `pg` module absent; only several dependency-light smokes passed before failure. Install exactly from lockfile, then rerun; do not call this a product regression yet |

No paid provider, production endpoint, sensitive record, deploy, restart, extension reload, phone install, or active process was touched.

## Immediate gaps to close before aggressive deletion

1. Make a hermetic Tier-3 runner the authoritative gateway gate: installed lockfile dependencies, temporary files, disposable Postgres, random ports, fake paid-provider servers, deterministic seed, and cleanup assertion.
2. Repair or explicitly characterize the current browser shortcut smoke failure before using it as a reduction oracle.
3. Add three Level-4 harnesses: browser voice roundtrip, Android fake-executor action/receipt, and cross-client interrupted-turn resume. They should query history after visible completion.
4. Convert a small consented set into sanitized Level-5 replays; do not use production text as fixtures.
5. Add JSON performance sampling around fixed journeys and compare distributions, not one-off wall time.
6. Publish a protected-behavior manifest mapping each behavior to fixture, evidence tier, owner, and command. Deletion is blocked when the manifest has no passing feasible tier for the affected behavior.

