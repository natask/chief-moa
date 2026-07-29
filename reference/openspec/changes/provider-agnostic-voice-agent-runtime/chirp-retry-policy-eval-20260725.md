# Chirp 3 retry and candidate-selection evaluation (2026-07-25)

## Scope and privacy

This paid STT-only evaluation replayed two explicitly authorized, pseudonymous
real-speech PCM fixtures. Each fixture/configuration pair was repeated five
times with identical bytes. No raw transcript was printed or persisted by the
harness. The adjacent JSON contains only transcript hashes, aggregate Unicode
script counts, provider metadata, error rates against prior provider
observations, latency, and request/cost accounting.

The prior observations are not user-verified linguistic ground truth. WER and
CER against them measure repeatability relative to those observations, not
semantic correctness. The corpus has no consented user-verified
technical-English reference, so technical-term preservation is unmeasured.

## Provider semantics verified

The request used Speech-to-Text V2 `Recognize`, model `chirp_3`, the `us`
multi-region endpoint, and explicit LINEAR16 16 kHz mono decoding.

Current Google documentation defines:

- `languageCodes=["auto"]` as language-agnostic transcription of the dominant
  language;
- an explicit locale list as conditioning recognition toward the listed
  languages, with the most likely detected language returned when available;
- `customPromptConfig` as a Chirp 3 custom-prompt feature;
- `Recognize` as the supported synchronous method for audio under one minute.

The provider returned one alternative per result even when three were
requested, and returned no confidence value in any of the 50 responses.
Therefore neither alternative voting nor confidence ranking is available in
this observed API path.

## Configurations and measured results

Five variants were evaluated over both fixtures, five repetitions each:

1. `auto`, no prompt.
2. `auto`, bilingual no-translation prompt.
3. `am-ET`, bilingual no-translation prompt.
4. `en-US,am-ET`, no prompt.
5. `en-US,am-ET`, bilingual no-translation prompt.

Every fixture/configuration pair was deterministic across all five repetitions:
one distinct transcript hash and 100% exact candidate agreement.

| Configuration | Wrong-script trials | Reference-relative result | Mean latency range |
| --- | ---: | --- | ---: |
| `auto`, no prompt | 5/10 | one fixture foreign-script; one fixture empty | 721–944 ms |
| `auto` + prompt | 0/10 | exact on fixture 1; WER 0.125/CER 0.029 on fixture 2 | 678–1,282 ms |
| `am-ET` + prompt | 0/10 | exact on both fixtures | 656–2,770 ms |
| `en-US,am-ET`, no prompt | 10/10 | foreign-script on both fixtures | 617–1,754 ms |
| `en-US,am-ET` + prompt | 0/10 | exact on fixture 1; WER 1/CER 1.143 on fixture 2 | 767–1,356 ms |

The explicit bilingual prompted output on fixture 2 was Latin/Ethiopic-valid
but materially different from the prior accepted observation. This directly
demonstrates that script validity cannot choose between incorrect and correct
Latin/Ethiopic candidates. The unprompted `auto` empty result also passed a
script-only predicate because it contained no foreign letters. Admission must
separately require non-empty speech and must not equate script validity with
transcript correctness.

## Retry and selection-policy findings

- Repeating the same audio/configuration did not vary once in 50 requests.
  Fixed-N same-config retries, consensus, and medoid selection add cost and
  latency without changing the candidate on this corpus.
- Stop-on-script-valid alone is unsafe. It would accept the empty `auto`
  candidate and the materially different explicit-bilingual prompted
  candidate.
- Provider language metadata is useful diagnostic evidence but not a correctness
  oracle. Wrong-script explicit-bilingual results had no language code, while
  the empty `auto` result reported `und`.
- Provider confidence cannot be used because it was absent. Requested
  alternatives cannot support voting because only one was returned.
- A per-user language/script policy is still valuable as a rejection boundary:
  derive allowed scripts from the user's admitted input language codes. For
  `am-ET,en-US`, allow Ethiopic and Latin letters plus Common/Inherited
  punctuation and combining marks. Do not hard-code this pair globally.

## Recommendation from current evidence

For this user's admitted English/Amharic policy:

1. Primary request: `languageCodes=["am-ET"]` with the pinned bilingual
   verbatim/no-translation prompt.
2. Do not repeat the same request. The observed provider behavior was fully
   deterministic.
3. If the primary candidate is empty, contains a disallowed script, or the
   provider fails, make at most one changed-configuration fallback request:
   `languageCodes=["auto"]` with the same pinned prompt.
4. Admit a fallback only when it is non-empty and script-valid. Treat that as
   safety eligibility, not proof of correctness.
5. Do not use `en-US,am-ET` as the retry configuration for this incident. It
   produced deterministic foreign script without the prompt, and with the
   prompt produced a script-valid but materially different candidate on one
   fixture.
6. Do not use confidence, multiple-alternative consensus, or same-config
   medoids until the provider actually returns those signals or a larger corpus
   demonstrates stochastic variation.
7. On rejection, do not send the text to reasoning, history, or rendering.
   Return a visible `transcript_rejected`/`wrong_script` or `no_speech` state and
   ask the user to repeat, type, or explicitly authorize review of that audio.

The primary recommendation is provisional for mixed technical English. Prior
five-case evidence found both prompted `am-ET` and prompted `auto` usable
without foreign substitution, but short embedded English terms could still be
transliterated. Promotion requires a consented, user-verified English/Amharic
technical corpus with exact term annotations.

## Accounting and independent-verification blocker

- Provider calls: 50.
- Estimated billed audio: 400 seconds, using per-request one-second rounding.
- Estimated cost at the documented $0.016/minute list price: $0.1067.
- Merge/deploy: intentionally not performed.

Independent verification should inspect the harness and sanitized artifact,
rerun deterministic contract tests, and decide whether the two-fixture evidence
is sufficient for a guarded experiment. Production promotion remains blocked
on the missing user-verified technical-English/code-switch corpus.
