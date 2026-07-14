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
3. Language-agnostic: `languageCodes=["auto"]`.
4. Fixed Amharic and language-agnostic mode, each with the same Chirp 3 custom
   prompt:

   ```text
   Transcribe the speaker verbatim. The speaker may switch between Amharic
   and English within one sentence. Preserve Amharic in Ethiopic script and
   preserve spoken English words in Latin script. Do not translate, omit, or
   rewrite either language.
   ```

The pure Amharic regression also tested reversed multilingual order
`["am-ET","en-US"]`; order did not change the wrong-script result.
Omitting `languageCodes` entirely was also tested and returned HTTP 400 because
the field must be non-empty. Chirp 3 represents language-agnostic operation with
`["auto"]`, not an absent field.

## Results

| Capture | `auto` | `auto` + prompt | `am-ET` | `en-US,am-ET` | `am-ET` + prompt |
| --- | --- | --- | --- | --- | --- |
| Pure Amharic wrong-script regression | Hindi 2/2 | correct 2/2 | correct 3/3 | Hindi 3/3 | correct 2/2 |
| Pure English control | correct 2/2 | correct 2/2 | correct 3/3 | correct 2/2 | correct 2/2 |
| Mixed: Amharic with one English token | lost token 2/2 | transliterated token 2/2 | lost/transliterated token 2/2 | preserved 2/2 | transliterated token 2/2 |
| Mixed: Amharic then English clause | dropped Amharic prefix 2/2 | preserved 2/2 | dropped English clause 2/2 | preserved 2/2 | preserved 2/2 |
| Mixed: English then Amharic clause | Latin transliteration 2/2 | preserved 2/2 | preserved 2/2 | dropped Amharic clause 2/2 | preserved 2/2 |

Google returned the effective prompt in response metadata. With `am-ET`, Google
prepended an internal instruction to transcribe in Amharic and respond in the
original language, Amharic. With `auto`, Google omitted that language-specific
instruction and retained a generic instruction to respond in the original
language. In both cases the custom prompt appeared inside Google's larger
provider-authored transcription prompt. This is observable behavior, not proof
of the model's unpublished internal architecture or precedence rules.

## Decision evidence

- Fixed `am-ET` is not limited to Ethiopic output: it transcribed the pure
  English control exactly while reporting `languageCode=am-ET`.
- Removing `languageCodes` is not a valid API configuration. `auto` is the
  supported language-agnostic value.
- `auto` alone is unsafe for this corpus: it repeated the Hindi substitution on
  pure Amharic and selected only the dominant language on two mixed captures.
- `auto` plus the code-switch prompt matched the strong results of prompted
  `am-ET`: it corrected the Hindi regression, preserved both long code-switch
  directions, and transliterated the short embedded English token.
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

No configuration earned a universal verbatim code-switch guarantee on this
small live corpus. Under a rubric that accepts meaning-preserving
transliteration, both `auto` plus the prompt and fixed `am-ET` plus the prompt
produced usable Amharic-English content across all five captures without a
foreign non-English substitution. `auto` plus the prompt avoids claiming a
single recognition locale, while fixed `am-ET` adds a provider-authored Amharic
bias. Choosing between them still needs a larger user-verified corpus and a
deterministic Latin/Ethiopic output policy before promotion.

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
