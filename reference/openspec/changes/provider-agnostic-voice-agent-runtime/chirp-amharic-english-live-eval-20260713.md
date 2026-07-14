# Chirp 3 Amharic-English live evaluation (2026-07-13)

## Question

Can Moa use one `am-ET` Chirp 3 recognition locale while still preserving
English and code-switched English-Amharic speech, avoiding the wrong-script
failure observed with `en-US,am-ET`?

## Evidence and privacy

Five archived production captures were replayed directly through Google Cloud
Speech-to-Text V2 `chirp_3`: one pure Amharic wrong-script regression, one pure
English control, and three genuine code-switched utterances. Each comparison
used the same PCM bytes and explicit LINEAR16 16 kHz mono decoding.

The raw audio remains in the protected VPS archive. It is not committed to Git.
The adjacent JSON evidence file stores opaque archive references, byte counts,
audio and reference-transcript SHA-256 digests, trial counts, and result
classifications without publishing raw user recordings or full transcripts.

## Configurations

1. Fixed Amharic: `languageCodes=["am-ET"]`.
2. Multilingual: `languageCodes=["en-US","am-ET"]`.
3. Fixed Amharic plus Chirp 3 custom prompt:

   ```text
   Transcribe the speaker verbatim. The speaker may switch between Amharic
   and English within one sentence. Preserve Amharic in Ethiopic script and
   preserve spoken English words in Latin script. Do not translate, omit, or
   rewrite either language.
   ```

The pure Amharic regression also tested reversed multilingual order
`["am-ET","en-US"]`; order did not change the wrong-script result.

## Results

| Capture | `am-ET` | `en-US,am-ET` | `am-ET` + code-switch prompt |
| --- | --- | --- | --- |
| Pure Amharic wrong-script regression | correct 3/3 | Hindi/Devanagari 3/3, no language code | correct 2/2 |
| Pure English control | correct 3/3 | correct 2/2 | correct 2/2 |
| Mixed: Amharic with one English token | lost/transliterated token 2/2 | preserved 2/2 | transliterated token 2/2 |
| Mixed: Amharic then English clause | dropped English clause 2/2 | preserved 2/2 | preserved 2/2 |
| Mixed: English then Amharic clause | preserved 2/2 | dropped Amharic clause 2/2 | preserved 2/2 |

## Decision evidence

- Fixed `am-ET` is not limited to Ethiopic output: it transcribed the pure
  English control exactly while reporting `languageCode=am-ET`.
- Fixed `am-ET` alone is not sufficient for arbitrary code-switching. It can
  omit a longer English clause or render a short English word phonetically in
  Ethiopic.
- Multilingual `en-US,am-ET` is also not sufficient. It preserved two mixed
  captures but dropped the Amharic clause from a third and deterministically
  produced Hindi for the pure Amharic regression.
- The code-switch prompt improved fixed `am-ET` from one of three exact mixed
  captures to two of three. It preserved both long switching directions but
  still transliterated a short embedded English token.
- Provider `languageCode` is not trustworthy as an output-language assertion:
  fixed `am-ET` labels a fully English transcript `am-ET`, and the wrong-script
  multilingual regression returned no language code.

No configuration earned a universal code-switch guarantee on this small live
corpus. The best candidate observed was fixed `am-ET` plus the code-switch
prompt, combined with a deterministic Latin/Ethiopic script allowlist, but it
still needs a larger user-verified corpus and an explicit policy for
transliterated or omitted embedded words before promotion.

## Reproduction contract

1. Fetch each protected user PCM by the session and turn identifiers in the
   adjacent JSON file through the authenticated voice-audio endpoint.
2. Verify byte length and SHA-256 before sending it to a provider.
3. Call Google Speech V2 `Recognize` in the `us` multi-region with model
   `chirp_3`, explicit LINEAR16 16 kHz mono decoding, and each configuration
   above.
4. Compare the result to the protected canonical transcript by SHA-256 and
   separately record Latin, Ethiopic, and foreign-script presence. A canonical
   transcript is prior provider evidence, not automatically human ground truth.
5. Keep this eval live and opt-in because it uses user audio and incurs provider
   cost. Never add it to the deterministic `npm run check` path.
