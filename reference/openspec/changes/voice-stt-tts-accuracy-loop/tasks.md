# Tasks

## 1. Reference Corpus And Baseline

- [ ] 1.1 Add at least 8 additional hand-verified `en-US` fixture pairs and
  8 additional `am-ET` fixture pairs to `gateway/test/fixtures/voice/`,
  covering short utterances, one longer multi-clause utterance, and one
  utterance with a technical term/acronym per language, following the
  existing `en-hello.{json,pcm}` / `am-selam.{json,pcm}` shape.
- [ ] 1.2 Add `gateway/test/fixtures/voice/wer-baseline.json` recording the
  accepted WER ceiling per language, generated from a first accuracy run
  and committed as the starting baseline.
- [ ] 1.3 Document the fixture format and how to record a new clip
  (recording tool, sample rate, PCM16 mono expectation) in
  `gateway/test/fixtures/voice/README.md`.

## 2. STT WER Regression Script

- [ ] 2.1 Add `gateway/scripts/eval-voice-accuracy.js`, reusing
  `wordErrorRate`/`tokenize`/`editDistance` exported from
  `eval-voice-roundtrip.js` rather than reimplementing them.
- [ ] 2.2 Group fixtures by language, compute per-language mean WER, and
  compare each against `wer-baseline.json` with a fixed tolerance (start at
  the same `WER_TOLERANCE = 0.34` used by the existing round-trip eval
  unless the larger corpus shows that tolerance is wrong for a specific
  language).
- [ ] 2.3 Exit 0 with a JSON summary when every language is within
  baseline + tolerance; exit non-zero with
  `{ regression: true, language, wer, baseline }` entries when not.
- [ ] 2.4 Add `"eval:voice:accuracy": "node scripts/eval-voice-accuracy.js"`
  to `gateway/package.json`.

## 3. TTS Intelligibility Proxy And Naturalness Sampling

- [ ] 3.1 In `eval-voice-accuracy.js`, add a TTS leg: synthesize each STT
  fixture's reference text through the active TTS provider, re-recognize
  the resulting audio through Chirp 3 STT, and compute WER between
  original text and re-recognition. Report this as
  `tts_intelligibility_wer` per language, separate from the STT metric.
- [ ] 3.2 Add the same regression comparison (against a
  `tts_intelligibility` baseline in `wer-baseline.json`) and the same
  non-zero exit behavior on regression.
- [ ] 3.3 Write the human naturalness sampling plan as a runbook:
  `reference/research/voice-accuracy/naturalness-sampling.md` — default N=5
  clips/week, drawn round-robin from the fixture corpus, rated 1-5, logged
  to a dated file. Do not build an automated approximation of this rating;
  state plainly in the runbook that it requires a human.

## 4. Scheduled Loop And Safety Gates

- [ ] 4.1 Wire a daily fixtures-mode run of
  `npm run eval:voice:accuracy` (no `VOICE_EVAL_LIVE`), using the repo's
  existing scheduling mechanism (the `/loop` skill or a documented cron
  entry — pick whichever the target environment already supports; do not
  introduce a new scheduler dependency).
- [ ] 4.2 On a detected regression, write a dated report to
  `reference/research/voice-accuracy/<date>-regression.md` containing the
  failing language(s), WER delta, and the fixture ids that failed. The
  loop stops there; it does not edit gateway source, tune prompts, or
  change provider config.
- [ ] 4.3 Add an explicit, separately invoked weekly live-mode path
  (`VOICE_EVAL_LIVE=1 npm run eval:voice:accuracy`) with a hard cap on
  fixture count per run (reuse the existing small fixture corpus, do not
  scale live spend with corpus growth) and a comment/doc note that it must
  never be scheduled to run unattended — matches the existing
  `moa-voice-qa` rule that live checks require the user present.
- [ ] 4.4 Add a smoke that asserts the fixtures-mode path opens zero
  network sockets and performs zero writes under `DATA_DIR/voice-turns`.

## 5. Corpus Growth From Real Failures

- [ ] 5.1 Document the procedure in
  `reference/research/voice-accuracy/corpus-growth-procedure.md`: pull a
  flagged turn via `GET /v1/voice/turns/{turnId}` (read-only), get
  explicit human confirmation of the correct reference transcript, then
  commit a new fixture pair under `gateway/test/fixtures/voice/`.
- [ ] 5.2 Extend `moa-voice-qa`'s turn-id audit step with a pointer to this
  procedure so a real failure found during normal QA has a documented path
  into the regression corpus instead of being fixed once and forgotten.

## 6. Docs

- [ ] 6.1 Add a short "STT/TTS accuracy loop" subsection to
  `ARCHITECTURE.md`'s voice section, naming the metric definitions (WER for
  STT, re-STT intelligibility proxy for TTS, human sampling for
  naturalness), the schedule, and the safety gates — and correct the
  existing aspirational "replayable verification evidence... expected-test
  criteria" language to either mark it explicitly not-yet-built or link it
  to this change if a later task builds it.
- [ ] 6.2 Cross-link this change from `open-voice-reliability-control-plane`
  and `provider-agnostic-voice-agent-runtime`'s `voice-product-diagnostics`
  spec as "related, not duplicated" so a future reader does not propose a
  third overlapping change.
