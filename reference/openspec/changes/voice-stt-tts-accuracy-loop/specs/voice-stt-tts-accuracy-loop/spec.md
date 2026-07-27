# voice-stt-tts-accuracy-loop

## ADDED Requirements

### Requirement: STT accuracy is measured as word error rate against a human-verified corpus, per language

The gateway SHALL maintain a checked-in fixture corpus under
`gateway/test/fixtures/voice/` with a hand-verified reference transcript
per clip, and SHALL report STT accuracy as word error rate (WER) computed
by the existing `wordErrorRate` helper, aggregated separately for `en-US`
and `am-ET`. A single combined WER across languages SHALL NOT be reported
as the headline metric, because the two legs have materially different
known failure rates.

#### Scenario: accuracy run reports per-language WER

- GIVEN the fixture corpus contains both `en-US` and `am-ET` clips
- WHEN `npm run eval:voice:accuracy` runs in fixtures mode
- THEN the output includes a distinct WER value for `en-US` and for
  `am-ET`
- AND no single blended WER number is presented as the sole result.

### Requirement: A committed baseline defines what counts as a regression

The gateway SHALL store a WER ceiling per language and per metric (STT WER,
TTS intelligibility WER) in `gateway/test/fixtures/voice/wer-baseline.json`.
The accuracy script SHALL compare each run's measured WER against that
baseline plus a fixed tolerance and SHALL report `regression: true` for any
language/metric pair that exceeds it.

#### Scenario: STT WER exceeds baseline

- GIVEN the `am-ET` baseline WER is 0.20 with tolerance 0.34
- WHEN a run measures `am-ET` WER at 0.30
- THEN the run reports `regression: false` for `am-ET` (within tolerance)

#### Scenario: STT WER regresses past tolerance

- GIVEN the `am-ET` baseline WER is 0.20 with tolerance 0.34
- WHEN a run measures `am-ET` WER at 0.60
- THEN the run reports `{ regression: true, language: "am-ET", wer: 0.60,
  baseline: 0.20 }`
- AND the process exit code is non-zero.

### Requirement: TTS quality uses an honest automated proxy plus a disclosed human sampling plan, never a fabricated automated score

The gateway SHALL NOT report an automated "TTS quality" or "naturalness"
number. It SHALL instead report two distinct signals: an automated
intelligibility proxy computed by synthesizing each fixture's reference
text and re-recognizing the result through STT (WER between original text
and re-recognition), and a documented, explicitly human-driven naturalness
sampling procedure that is not automated and is not represented as a
number produced by the accuracy script.

#### Scenario: intelligibility proxy catches a synthesis regression

- GIVEN the TTS leg is misconfigured and returns truncated audio for long
  replies
- WHEN the accuracy script re-recognizes the synthesized audio for a
  multi-clause fixture
- THEN the re-recognition WER against the original reference text rises
  and the run reports a `tts_intelligibility` regression for that fixture's
  language.

#### Scenario: naturalness is never silently automated

- GIVEN the accuracy script has finished a full run
- WHEN its JSON output is inspected
- THEN it contains no naturalness/quality score field, only
  `tts_intelligibility_wer`
- AND the naturalness sampling runbook
  (`reference/research/voice-accuracy/naturalness-sampling.md`) states that
  a human must rate the sampled clips.

### Requirement: The scheduled loop defaults to zero-cost, zero-network fixtures mode and never spends live-provider budget unattended

The scheduled accuracy run SHALL default to fixtures mode (no live provider
socket, no cost), matching the existing `npm run eval:voice` default. A
live-mode run (`VOICE_EVAL_LIVE=1`) SHALL only execute when explicitly
invoked by a human-set flag and SHALL NOT be part of the unattended
schedule.

#### Scenario: daily scheduled run stays offline

- GIVEN the daily schedule invokes `npm run eval:voice:accuracy` with no
  `VOICE_EVAL_LIVE` set
- WHEN the run executes
- THEN it opens no outbound network socket to a live STT/TTS provider
- AND it incurs no provider cost.

#### Scenario: live-mode run requires an explicit human action

- GIVEN a live-mode accuracy run is desired
- WHEN it is invoked
- THEN it requires `VOICE_EVAL_LIVE=1` to be set by an explicit human
  action, not by the scheduled/unattended path
- AND the run is bounded to the existing small fixture corpus rather than
  scaling spend with corpus size.

### Requirement: A detected regression produces a durable, non-executing report and never triggers autonomous tuning

On a detected regression, the loop SHALL write a dated report under
`reference/research/voice-accuracy/` naming the failing language(s), the
WER delta, and the failing fixture ids. It SHALL NOT modify gateway source,
prompts, model selection, or provider configuration, and SHALL NOT restart
or redeploy the live gateway.

#### Scenario: regression is reported, not fixed

- GIVEN the daily run detects an `en-US` STT regression
- WHEN the loop completes
- THEN a dated report exists under `reference/research/voice-accuracy/`
  naming the regression
- AND no gateway source file, prompt, or provider config was changed by the
  loop
- AND no deploy or restart was triggered by the loop.

### Requirement: The loop never mutates production voice-turn storage or bypasses the STT-garbage profile-write guard

Every read the loop performs against stored voice turns SHALL use the
existing token-authenticated `GET /v1/voice/turns/{turnId}` route and SHALL
NOT write, delete, or modify anything under `DATA_DIR/voice-turns`. The
loop SHALL NOT call any route or code path that writes to the agent
profile from an unverified transcript, and SHALL NOT alter, disable, or
bypass the existing guard in `gateway/lib/voice-intent.js` /
`gateway/lib/agent-profile.js` that prevents a low-confidence transcript
from mutating profile state.

#### Scenario: reading a turn for corpus review is read-only

- GIVEN an agent is reviewing a real failed turn to consider adding it to
  the regression corpus
- WHEN it fetches the turn via `GET /v1/voice/turns/{turnId}`
- THEN no field of the stored turn record changes as a result
- AND no agent-profile field changes as a result.

#### Scenario: corpus growth requires explicit human confirmation

- GIVEN a candidate fixture is sourced from a real production turn
- WHEN it is proposed for addition to `gateway/test/fixtures/voice/`
- THEN the commit is preceded by an explicit human confirmation of the
  correct reference transcript
- AND no raw production audio enters the committed corpus without that
  confirmation step.

### Requirement: This change is distinct from existing voice-observability and single-turn diagnosis work

The STT/TTS accuracy loop SHALL be documented as related to but distinct
from `open-voice-reliability-control-plane` (endpoint/gateway playout
observability product) and
`provider-agnostic-voice-agent-runtime`'s `voice-product-diagnostics`
(single-turn root-cause diagnosis). Future changes SHALL cross-reference
rather than re-propose overlapping scope.

#### Scenario: a future contributor searches for accuracy-loop work

- GIVEN a contributor greps `reference/openspec/changes/` for
  voice-accuracy work
- WHEN they find `open-voice-reliability-control-plane` or
  `voice-product-diagnostics`
- THEN both documents point to `voice-stt-tts-accuracy-loop` as the owner
  of the recurring accuracy-metric loop, avoiding a duplicate proposal.
