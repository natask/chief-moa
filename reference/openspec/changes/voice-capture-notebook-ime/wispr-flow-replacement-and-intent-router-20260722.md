# Wispr Flow Replacement And Intent Router Direction (2026-07-22)

## Product outcome

Moa should replace Wispr Flow for the user's daily English, Amharic, and
code-switched dictation. One explicit system invocation starts capture. A second
invocation finishes it. The literal transcript becomes paste-ready text without
requiring an assistant reply.

That capture is also the intake primitive for a broader intent system. Moa
preserves what the user said, then classifies the expression without destroying
the source:

```text
literal capture
  -> paste/copy now
  -> durable thought or note
  -> project or active-run relation
  -> explicit intent
  -> independent research questions
  -> proposed agent work
```

The first action must stay cheap. Dictation does not wait for categorization,
research, synthesis, or an agent run. Those are asynchronous derived operations
over the canonical capture.

## Product invariants

- Mixed-language speech is transcribed literally before any rewrite.
- Dictation invokes STT only. It does not spend a reasoning or TTS call.
- The literal transcript remains searchable even after later categorization,
  rewriting, or dispatch.
- Classification is a proposal with provenance and confidence, not a mutation of
  the user's words.
- Receiving a thought does not silently fan out agents. Moa may propose bounded
  research lanes; execution follows explicit dispatch or a separately approved
  project policy.
- A user can later ask what they said about a subject and retrieve the source
  capture plus its derived relations.

## Staged path

1. Browser/macOS system summon to literal transcript and clipboard.
2. Durable capture blocks with copy, edit, retry, retention, and search.
3. Append-only classifications for note, fact, question, intent, project
   relation, and research candidate.
4. Cross-reference new captures against existing intents, projects, sessions,
   and evidence.
5. Show a routing proposal: file only, answer, attach to active work, open one
   lane, or propose a bounded multi-lane job.
6. Dispatch approved work into the canonical intent runtime and keep run,
   evidence, completion, and verification state visible.

## Current slice

The browser-owned macOS path now uses the existing global Chrome command and
Chirp capture. It produces a canonical transcription-only voice turn and copies
the final literal transcript locally. Cross-application insertion remains an
explicit paste action; the browser receives no authority to type into another
application.

## Next acceptance check

Persist a completed dictation as a queryable capture block and attach one
append-only routing proposal without delaying clipboard delivery or launching
an agent.
