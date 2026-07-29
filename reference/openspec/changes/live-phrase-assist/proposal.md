# Live Phrase Assist

## Why

The user wants an optional background aid that can supply the short phrase they
appear to be searching for during a real pause in speech. Existing voice turns
stream partial transcripts, but all reasoning begins after commit and produces
a conversational answer. Reusing that path would turn incomplete speech into an
actionable turn, expose unrelated context, and risk tool or agent side effects.

## What Changes

- Add a versioned, default-off phrase-assist capability to streaming voice
  sessions.
- Let an opted-in client request one suggestion for an exact transcript
  revision after its local pause detector fires, and cancel it when speech
  resumes.
- Generate from only the latest normalized transcript snapshot through one
  short-output model adapter with tools and native search disabled.
- Bound suggestions to eight words and 64 characters, suppress stale work, and
  apply request idempotency plus a per-session-turn rate limit.
- Keep suggestions transient. They do not commit the voice turn, alter the
  transcript, enter conversation history, launch work, invoke tools, play TTS,
  or mutate a profile.
- Keep phrase-assist diagnostics content-free. They may contain request IDs,
  transcript revision and length, timing, terminal status, and output length,
  but not transcript or suggestion content.

## Relationship To Coaching And Speculative Reasoning

Phrase assist is not automatic speech correction or grading. The user explicitly
enables it, the surface explicitly requests it at a pause, and the result is a
short phrase-finding hint. This preserves the existing rule that silence,
pauses, screen text, and model output do not implicitly change voice mode.

Phrase assist is also not speculative execution of the conversational reasoner.
Incomplete speech remains evidence rather than an instruction. No resulting
phrase can answer the turn, speak automatically, or cause an action.

## Scope

This change implements the gateway protocol, coordinator, generation boundary,
diagnostics, and tests. Android and browser pause detection, presentation, and
user controls remain follow-up surface work.
