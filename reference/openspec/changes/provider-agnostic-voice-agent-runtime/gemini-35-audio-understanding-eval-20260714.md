# Gemini 3.5 Flash audio-understanding evaluation (2026-07-14)

## Question

Can `gemini-3.5-flash` act as a controllable audio-in/text-out adapter for
Amharic, English, and code-switched speech without giving a Live API model
ownership of Moa's context, tools, or response generation?

## Execution

The five protected PCM captures used by the Chirp 3 evaluation were replayed
through Vertex AI `generateContent` in the `global` location. The evaluator
wrapped the original LINEAR16 16 kHz mono bytes in a WAV header and supplied the
audio as inline `audio/wav`. Raw audio was not modified or committed.

Model: `gemini-3.5-flash`

Endpoint class: ordinary Vertex generative model request, not Gemini Live

Authentication: existing local Vertex ADC; no new API key was required

Twenty paid requests completed successfully: five captures under each of three
prompt modes, plus a second five-capture strict trial. Completed request latency
was 1.6-3.2 seconds. This is post-capture request/response behavior, not partial
streaming transcription.

The evaluator requested structured JSON containing a combined transcript,
language list, language spans, scripts, uncertainty flags, and notes. Tool use,
TTS, agent launching, and production gateway state were not involved.

## Prompt modes

`minimal` requested verbatim transcription, no translation, language-change
segmentation, and uncertainty rather than guessing. It named no languages or
scripts.

`bilingual` added that the speaker may switch between Amharic and English.

`strict` also required Ethiopic script for Amharic, Latin script for English,
and prohibited substitution with Hindi, Kannada, or another language.

## Results

| Capture | Minimal | Bilingual | Strict (two trials) |
| --- | --- | --- | --- |
| Pure Amharic wrong-script regression | Failed: classified/transcribed as Albanian in Latin script | Target script, but short English-sounding material was absorbed into Ethiopic | Target script, but materially different Amharic sentences across identical trials |
| Pure English control | English; omitted the leading question material | English; omitted the leading question material | English; omitted the leading question material in both trials |
| Mixed: Amharic with one English token | Meaning largely preserved, embedded `no` absorbed into Ethiopic | Same; did not create an English span | Same in both trials; did not create an English span |
| Mixed: Amharic then English clause | Failed prefix: classified the Amharic opening as German | Preserved both languages and scripts | Preserved both languages and scripts in both trials |
| Mixed: English then Amharic clause | Preserved both languages and scripts; Amharic wording differed from prior reference | Preserved both languages and scripts; wording varied | Preserved both languages and scripts; Amharic wording varied between trials |

The previously stored transcripts are provider evidence, not human ground
truth. Consequently, "wording differed" is not automatically a model error.
The foreign-language substitutions, missed leading audio, missed embedded
English span, and materially inconsistent repeated output are independently
observable failures.

## Findings

- Gemini 3.5 Flash accepts the audio and produces bounded structured text on
  the current Vertex credentials. The basic integration path is proven.
- Prompting strongly changes language recognition. Without naming Amharic and
  English, the same known Amharic material was confidently labelled Albanian
  or German. Merely naming the two possible languages removed those foreign
  substitutions in this corpus.
- The model handled longer Amharic-English switches in both directions much
  better than short embedded tokens.
- Script instructions are not sufficient to preserve a very short English
  token. The model rendered `no` phonetically in Ethiopic or absorbed it into
  the surrounding Amharic.
- Temperature zero did not make transcription deterministic. The shortest
  Amharic capture produced materially different sentences across identical
  strict calls.
- Structured uncertainty is useful but not calibrated enough to trust by
  itself: several visibly unstable or reference-divergent outputs were marked
  `uncertain: false`.
- Latency is compatible with a post-turn correction or semantic-recovery pass,
  not with the existing requirement for live partial captions.

## Decision

Do not replace streaming Chirp with Gemini 3.5 Flash as the sole canonical
transcriber from this evidence.

Proceed with a provider-neutral audio-understanding trial in which:

1. streaming STT continues to supply live partials;
2. the completed audio chunk is independently sent to Gemini 3.5 Flash with
   the strict bilingual structured prompt;
3. both candidates and provenance are stored;
4. deterministic arbitration detects foreign scripts, missing language spans,
   divergent meaning, and low-confidence/unstable cases;
5. the winning canonical utterance—not the audio model session—enters intent,
   context, and agent-launch planning.

Human verification of the five reference transcripts is still required before
word-error or exact-match claims can be made.

## Reproduction

```text
PATH="$HOME/.nvm/versions/node/v22.13.1/bin:$PATH" \
VERTEX_LOCATION=global \
node gateway/scripts/eval-gemini-audio-understanding.mjs \
  /tmp/moa-native-audio-eval-20260714 gemini-3.5-flash strict
```

The evaluator is live, paid, and opt-in. It must not be placed in the default
gateway check path.
