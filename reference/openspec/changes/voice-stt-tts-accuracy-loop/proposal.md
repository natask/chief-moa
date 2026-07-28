# STT/TTS Accuracy Audit Loop

## Why

On 2026-07-16 the user assigned a standing task: dedicate an agent to
continuously audit and improve STT and TTS accuracy. It has no owning
change anywhere on disk, so it never ran.

The pieces to build on already exist and should not be rebuilt:

- The cascaded pipeline is real: Chirp 3 STT (`en-US`, `am-ET`) -> gateway
  LLM -> Chirp 3 / gemini-tts hosted TTS. `/health` reports the active
  pipeline under `voice_stream.provider`. Gemini/Vertex Live is a
  switchable `legacy-live` mode, out of scope here.
- `gateway/scripts/eval-voice-roundtrip.js` (`npm run eval:voice`) already
  computes word error rate (`wordErrorRate` in that file) between a
  fixture's `expected_transcript` and the transcript the real session
  server produces, in fixtures mode (deterministic, offline, free) or live
  mode (`VOICE_EVAL_LIVE=1`, real Vertex/Chirp sockets, costs money).
- The fixture corpus today is two clips:
  `gateway/test/fixtures/voice/en-hello.{json,pcm}` and
  `am-selam.{json,pcm}`. One clip per language is not a baseline, it is a
  smoke test.
- Voice turns persist under `DATA_DIR/voice-turns/<session_id>/<turn_id>.json`
  (`gateway/server.js`) and are readable via
  `GET /v1/voice/turns/{turnId}` and re-STT'd via
  `POST /v1/voice/turns/:sessionId/:turnId/retranscribe` — both token-
  authenticated, both already read/mutate only that one turn, neither
  requires new gateway surface.
- `moa-voice-qa` (the maintenance skill) already verifies one turn end to
  end and audits a stored turn on demand, but it runs when a human notices
  a problem. It has no trend, no baseline, and no schedule.
- `ARCHITECTURE.md` documents an aspirational "replayable verification
  evidence" primitive (voice turns retained with "expected-test criteria"
  for later replay). That field does not exist in `gateway/server.js` or
  `gateway/lib/*` today — it is a described but unbuilt idea, not
  something this change can assume.

This change is the missing link: a measurable baseline, a regression
signal, and a loop that runs on a schedule instead of only when a human
happens to notice a bad turn.

## What Changes

1. **Grow the labelled STT corpus, per language, under human review.**
   Add curated fixture pairs (audio + hand-verified reference transcript)
   to `gateway/test/fixtures/voice/`, split and reported separately for
   `en-US` and `am-ET` because the two legs have different known failure
   rates (am-ET is the weaker leg). Corpus growth from real usage goes
   through a documented, human-in-the-loop procedure (Task 5) — never an
   automatic scrape of `DATA_DIR/voice-turns`.

2. **Add a committed WER baseline and a regression check.** A new
   `gateway/test/fixtures/voice/wer-baseline.json` records the last-
   accepted WER ceiling per language. A new script,
   `gateway/scripts/eval-voice-accuracy.js`, runs every fixture through the
   existing `wordErrorRate` helper, reports per-language WER, and exits
   non-zero with a structured `{regression: true, language, wer,
   baseline}` result when a language's WER exceeds its baseline by more
   than a fixed tolerance. This is the STT metric: **word error rate against
   a checked-in, human-verified reference set, reported separately per
   language.**

3. **Define an honest, checkable TTS signal instead of hand-waving
   "quality."** Automated TTS "naturalness" is not cheaply or honestly
   measurable — this change does not pretend otherwise. It defines two
   separate signals instead of one fake number:
   - **Automated intelligibility proxy (cheap, runs every cycle):**
     synthesize each STT fixture's reference text through the active TTS
     leg, re-recognize the resulting audio through Chirp 3 STT, and compute
     WER between the original reference text and the re-recognition. This
     measures "can the STT leg understand what the TTS leg said," which is
     a real, checkable number, not a proxy for how a human would rate it.
     It catches synthesis regressions (garbled audio, wrong language,
     truncated output) without requiring a human in the loop.
   - **Human naturalness rating (expensive, sampled, explicitly not
     automated):** a bounded weekly sampling plan — N synthesized clips
     (default 5) drawn from the same fixture corpus, rated 1-5 by the user
     or a designated reviewer, logged to a dated file under
     `reference/research/voice-accuracy/`. This change specifies the
     sampling and logging mechanism only; it does not claim to automate or
     approximate the rating itself.

4. **Wire a scheduled loop with hard safety gates.** A cadence (default
   daily) runs `npm run eval:voice:accuracy` in fixtures mode only — zero
   cost, no live provider socket, matching the existing `eval:voice`
   default. A separate, explicitly opt-in weekly live-mode run
   (`VOICE_EVAL_LIVE=1`) is gated behind a manual flag and a hard per-run
   budget/turn-count cap; it never runs unattended. On a detected
   regression the loop writes a dated report under
   `reference/research/voice-accuracy/` and stops there — it proposes,
   it does not auto-tune prompts, models, or provider config, and it never
   touches production `DATA_DIR/voice-turns` or the live gateway.

5. **Document the corpus-growth procedure from real failures.** When
   `moa-voice-qa`'s turn-id audit (or the user) finds a real STT/TTS
   failure, the procedure to add it to the regression corpus is: pull the
   turn read-only via `GET /v1/voice/turns/{turnId}`, get explicit human
   confirmation of the correct reference transcript, then commit a new
   fixture pair. Raw production audio is never copied into the checked-in
   corpus without that explicit human confirmation step — this mirrors the
   consent language already in `ARCHITECTURE.md`'s billing/telemetry
   boundaries applied to voice content.

## Non-Goals

- No autonomous prompt, model, or provider-config tuning. The loop reports
  regressions; a human decides what to change. (Mirrors the "production
  authority remains human-controlled" boundary already adopted in
  `open-voice-reliability-control-plane`, which this change deliberately
  does not duplicate — see below.)
- No live-provider spend without an explicit, human-set opt-in flag. The
  scheduled default is fixtures-mode only, exactly like today's
  `npm run eval:voice` default.
- No writing to, mutating, or deleting anything under production
  `DATA_DIR/voice-turns`. All reads of stored turns use the existing
  token-authenticated `GET /v1/voice/turns/{turnId}` route read-only.
- No weakening, bypassing, or removing the existing STT-garbage
  profile-write guard (`gateway/lib/voice-intent.js`,
  `gateway/lib/agent-profile.js`) that prevents a bad transcript from
  mutating the agent profile. This change adds measurement, not a new
  write path.
- No claim that an automated TTS naturalness score exists. Section 3 is
  explicit about what is measured automatically (intelligibility via
  re-STT) versus what still requires a human rating.
- Not a rebuild of `open-voice-reliability-control-plane` (endpoint/gateway
  playout-timeline observability product with external design partners) or
  `provider-agnostic-voice-agent-runtime/specs/voice-product-diagnostics`
  (single-turn root-cause diagnosis commands). Both already exist and cover
  different problems: this change is the missing recurring accuracy-metric
  loop, not a new observability platform or a new single-turn diagnostic
  tool.
- No new gateway HTTP routes. Everything reads through routes that already
  exist (`GET /v1/voice/turns/{turnId}`, the retranscribe route for
  optional re-check, `/health` for pipeline detection).

## Boundaries

- Gateway owns the fixture corpus, the baseline file, the accuracy script,
  and the scheduled-run wiring. No Android or browser changes.
- The scheduled loop is read-only against production state: it only calls
  fixtures-mode eval (no network) by default, and optionally calls live
  provider sockets under an explicit human-set flag — it never calls a
  route that mutates `DATA_DIR/voice-turns` or the agent profile.
- Reports land under `reference/research/voice-accuracy/`, not in chat-only
  form, matching `AGENTS.md`'s "do not use chat as the only record of
  decisions."

## Verification

- `cd gateway && npm run check` (existing gate, unchanged).
- `cd gateway && npm run eval:voice` (existing fixture round-trip, unchanged
  behavior).
- `cd gateway && npm run eval:voice:accuracy` (new): reports per-language
  WER and the TTS intelligibility proxy, exits 0 when within baseline,
  exits non-zero with a structured regression payload when not.
- A dedicated smoke proves the accuracy script never opens a live socket
  unless `VOICE_EVAL_LIVE=1` is explicitly set, and never writes to
  `DATA_DIR/voice-turns`.
