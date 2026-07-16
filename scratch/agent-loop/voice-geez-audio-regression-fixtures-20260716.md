# Geʽez real-audio regression fixture lane

## Acceptance

- Preserve the two user-authorized recordings byte-for-byte under pseudonymous
  fixture names without production turn/session/user identifiers.
- Make default verification network-free and assert file integrity, PCM16LE
  framing/duration, current provider-auto request composition and prompt policy,
  rejection of observed Devanagari output, and acceptance of Ethiopic replay
  observations.
- Provide an explicit paid live STT-only evaluator that cannot run from the
  default command, does not invoke LLM or TTS, and emits only non-content
  metadata rather than transcript text.

## Candidate contents

- Corpus: `gateway/test/fixtures/voice/chirp-language-regressions`.
- Prompt policy: `chirp-geez-amharic-english-v1`, SHA-256
  `01fd7278ea7a8fd95d6b06dc34d86a1f63b3013585b1458da40da039adcad554`.
- Deterministic test: `gateway/test/chirp-language-regression-fixtures.test.js`.
- Paid opt-in: `VOICE_EVAL_LIVE=1 npm run
  eval:voice:chirp-language-regressions -- live`.

## Evidence and limits

The manifest records exact byte counts, audio hashes, duration, timestamp,
surface, known-bad provider transcripts, and accepted prompted provider
observations. The recordings are real user speech and durable Git content; the
README and manifest record the explicit authorization and history/clone
revocation caveat. Accepted Ethiopic output is not user-verified wording and no
WER claim is made.

Narrow development checks:

- `node --test test/chirp-language-regression-fixtures.test.js` — pass (3/3).
- `npm run eval:voice:chirp-language-regressions` — pass, network-free skip.
- `node scripts/eval-chirp-transcription-fixtures.js live` with
  `VOICE_EVAL_LIVE=0` — correctly refused before loading provider/auth code.
- `node scripts/smoke-chirp-provider.js`, source-size policy, changed-file syntax,
  `git diff --check`, and strict OpenSpec validation — pass.
- Full `npm run check` was attempted with the existing dependency tree. Its
  broad smoke orchestrator produced numerous unrelated child-smoke failures and
  a 120-second macOS proactive timeout, then did not terminate; the run was
  interrupted. The focused Chirp provider and new default fixture tests passed
  in that same candidate.
- Paid live evaluator — not run; requires separate explicit environment gate
  and incurs provider cost.
- Privacy regression: the live result formatter exposes fixture id, byte and
  character counts, and script-policy status only; a deterministic assertion
  proves the recognized text is absent.
