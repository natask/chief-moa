# Minimal Chief MOA acceptance test

## Scenario

Nat starts a private 15-minute spoken session in the notch or transcript
surface, speaks through a mixed and imperfect explanation, then asks for
coaching after capture ends.

## Pass conditions

1. The notch shows an unmistakable recording state and elapsed time within one
   second of capture start.
2. Partial transcript text appears without being pasted into the active app.
3. No correction, score, or coaching prompt appears while Nat speaks.
4. An app switch or screen interruption does not discard finalized transcript
   text.
5. When Nat stops, the surface offers clipboard copy and a separate "Review my
   speech" action.
6. The review action states what source will be analyzed and asks for consent
   before admitting the transcript to the private coaching session.
7. The review returns at most two corrections and one exercise.
8. Each correction names the pattern, listener cost, short redacted example,
   candidate phrase, and confidence.
9. The system excludes uncertain transcript spans and sensitive content from
   saved examples.
10. The system saves no raw transcript after the review unless Nat chooses to
    retain it.
11. Nat can delete the session's transcript and derived measures from the same
    surface.
12. The surface labels the feature as coaching support and makes no medical
    claim.

## Failure checks

Fail the test if Chief MOA:

- interrupts capture with a wording suggestion;
- rewrites the whole turn into a different voice;
- shows more than two corrections;
- silently analyzes or retains the transcript;
- quotes relationship, intimate, health, credential, or third-party details;
- produces a diagnosis or claims to replace professional care;
- reports a trend from fewer than three comparable sessions.

## Proposed notch and transcript flow

```text
Idle -> Recording -> Finalizing -> Ready
                               -> Copy
                               -> Route intent
                               -> Review speech
```

Keep `Route intent` separate from `Review speech`. A transcript may support
product routing without becoming coaching data.
