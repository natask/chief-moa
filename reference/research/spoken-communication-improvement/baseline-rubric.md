# Baseline rubric

## Current baseline

No transcript-level baseline exists yet. The admitted intake states Nat's goals
but does not contain the source speech needed for honest counts. Do not infer
filler rate, reference clarity, pace, fluency, confidence, or a clinical
condition from the recap.

The first baseline starts only after Nat admits one bounded transcript for this
purpose. Remove sensitive content before analysis.

## Session header

Record:

- date and duration;
- mode: free ideation, technical explanation, plan, story, or conversation;
- intended audience;
- intended outcome;
- transcript source and consent state;
- transcript confidence or uncertain spans;
- approximate word and sentence count.

## Measures

| Measure | Operational definition | Normalization |
|---|---|---|
| Unclear reference | A listener cannot choose one referent from local context | per 1,000 words |
| Avoidable filler | A repeated token or phrase that adds no stated meaning in this sample | per 100 words |
| Restart | A clause is abandoned or repeated before its claim completes | per 100 sentences |
| Buried claim | The main assertion appears only after two or more setup clauses | share of sampled claims |
| Unspecified comparison | Words such as better, faster, larger, or efficient lack a baseline or target | share of comparisons |
| Unmeasured quantity | A quantity claim lacks a count, range, rate, unit, scale, or ordinal definition when one is needed | share of quantity claims |
| Loose dimension | A named property mixes distinct quantities or omits what varies | count per session |
| Undefined index | A combined score lacks components, direction, weights, or predicted outcome | share of index proposals |
| Repair | Nat or a listener restates a point because the first wording did not land | count per session |

Fillers include only items that are frequent in this speaker and removable in
that context. Do not count pauses, repetitions used for emphasis, or discourse
markers that help structure the thought.

## Human ratings

After the review, Nat rates:

- Did the feedback preserve my voice? 1 to 5.
- Did it preserve the idea I meant? 1 to 5.
- Was either correction useful in the re-say? 1 to 5.
- Did capture let me think without interruption? yes or no.

Stop or revise the method if preserved voice or preserved meaning falls below 4
in two sessions.

## Sampling protocol

1. Use one continuous 10-to-15-minute sample.
2. Analyze the final transcript after the turn ends.
3. Mark low-confidence transcription spans and exclude them from correction
   counts.
4. Select up to ten claims for the dimensional measures.
5. Have a second pass check each proposed correction against local context.
6. Rank candidates with the contract in `README.md`.
7. Show at most two corrections.
8. Save only approved derived measures and redacted examples.

## Baseline report template

```text
Mode:
Audience:
Outcome:
Words:
Capture uninterrupted: yes/no

Observed pattern:
Rate:
Listener cost:
Candidate phrase:
Confidence:

Observed pattern:
Rate:
Listener cost:
Candidate phrase:
Confidence:

Preserved voice:
Preserved meaning:
Usefulness:
Next-session cue:
```

