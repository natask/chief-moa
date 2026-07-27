# Spoken communication improvement

Status: private coaching notebook  
Owner: Nat  
Source boundary: minimized typed intake only  
Created: 2026-07-25

## Purpose

Help Nat speak with more precision while protecting long-form thought. Capture
comes first. Coaching comes after the speaking interval unless Nat asks for live
help.

This notebook supports practice and reflection. It does not diagnose a speech
condition or replace a speech-language pathologist or other professional.
Professional guidance takes priority when it applies.

## Product and learning contract

1. Let the thought finish. Never interrupt a long-form turn to correct wording.
2. Preserve voice. Prefer a precise local edit over rewriting the speaker into
   a generic concise style.
3. Limit feedback. Return at most two corrections and one practice prompt after
   a normal 15-minute session.
4. Earn a correction. Surface it only when the pattern is frequent, changes the
   meaning or listener effort, and has a usable replacement.
5. Separate observation from inference. Quote only a short, non-sensitive span
   from an authorized transcript. Mark the likely meaning as a hypothesis.
6. Ask when meaning is unclear. Do not silently resolve names, pronouns, units,
   or technical terms.
7. Track patterns, not private subject matter. Store counts and short redacted
   examples. Do not retain relationship or intimate content.
8. Let Nat control collection, retention, export, and deletion.
9. Treat improvement as task-specific. Clear technical explanation, free
   ideation, storytelling, and conversation can need different pacing.
10. Use coaching language. Never make a medical claim.

## Feedback timing

During speech, show capture state, elapsed time, and a quiet transcript preview.
Allow one user-triggered marker such as "flag that" without opening a coaching
panel. Do not show correction badges, scores, or rewritten phrases.

After speech, wait for final transcription. Then show:

- the main idea as the system understood it;
- up to two high-value edits;
- one replacement phrase for each edit;
- one short practice prompt;
- a private trend only when enough comparable sessions exist.

## Fifteen-minute review

Use this format after a bounded speaking interval:

1. Recall, 2 minutes. Nat states the intended point and audience.
2. Review, 5 minutes. Chief MOA shows two selected moments with redacted
   context, the listener cost, and a candidate replacement.
3. Re-say, 5 minutes. Nat explains the same idea again without reading a full
   rewrite.
4. Record, 2 minutes. Save pattern counts, Nat's usefulness rating, and one
   chosen phrase.
5. Close, 1 minute. End with one cue for the next session.

## Correction selection

Score each candidate from 0 to 2 on frequency, listener cost, transfer value,
and confidence. Subtract 0 to 2 for voice-flattening risk.

`priority = frequency + listener cost + transfer value + confidence - voice risk`

Show a correction only when:

- priority is 5 or more;
- confidence is at least 1;
- the example contains no sensitive content;
- a shorter or more exact phrase preserves the intended claim.

Choose no more than one correction from the same pattern family. Prefer a
recurring pattern over a one-off stumble. Suppress corrections caused by
transcription uncertainty.

## Candidate phrase substitutions

These are practice options. They are not automatic rewrites.

| When speech says | Try |
|---|---|
| "this thing" | name the object, claim, decision, or process |
| "that" with two possible referents | "that result," "that constraint," or the proper name |
| "a lot" | give a count, range, rate, or comparison |
| "better" | name the metric and comparison point |
| "it works" | state the input, observed result, and conditions |
| "kind of" when certainty matters | "I estimate," "I suspect," or "the evidence shows" |
| repeated "like" before an example | "for example" once, then give the example |
| repeated restart | "My claim is..." and finish one sentence |
| "the dimension is..." | "The quantity is X, measured in Y" |
| "we need an index" | "Combine X and Y with these weights to predict Z" |

## Privacy and retention

- Default input is a transcript that Nat explicitly admits for coaching.
- Do not open audio, raw dictation, or other private sources without exact
  authorization.
- Process locally when the product can do so.
- Keep the raw transcript only for the active review by default.
- Save derived session measures only after Nat approves the review.
- Redact names, relationship details, intimate details, credentials, health
  details, and third-party identifiers before saving examples.
- Default derived-record retention is 30 days. Ask before longer trend storage.
- Support delete-one-session and delete-all-coaching-data actions.
- Never use coaching data for model training or unrelated intent routing without
  separate consent.

## Longitudinal view

Compare like sessions only. Tag the speaking mode and task before comparing
scores. Use a rolling median over the latest five comparable sessions. Do not
show a trend before three sessions.

Track:

- unclear references per 1,000 words;
- avoidable fillers per 100 words;
- abandoned or repeated starts per 100 sentences;
- claims with a named measure and comparison point;
- quantities with a stated unit or scale;
- indices with components, weights, and target outcome stated;
- listener repair requests, when supplied by Nat;
- Nat's 1-to-5 ratings for preserved voice and feedback usefulness;
- whether the chosen correction transfers to the next two comparable sessions.

Do not create one total communication score. A single score hides tradeoffs and
invites false precision.

## Files

- `baseline-rubric.md` defines the first measurement pass.
- `first-exercise.md` gives the first 15-minute practice.
- `chief-moa-acceptance-test.md` defines the smallest product check.

