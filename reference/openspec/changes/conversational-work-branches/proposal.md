## Why

A voice turn currently feels too much like one blocking request followed by one
answer. The user thinks aloud, pauses, adds more, starts several pieces of work,
and later returns to an older line of thought. The foreground conversation must
stay immediate while those independent threads remain durable and recoverable.

## What changes

- Treat an unsubmitted utterance as a resumable draft until explicit send.
- Give the foreground conversation a short, streaming response lane that does
  not wait for agent work to complete.
- Let one accepted message create several durable first-class work branches and
  runs without changing the active conversation unless the user asks.
- Make prior threads listable, describable, and switchable by voice.
- Preserve separate histories and provider caches per branch while presenting
  one continuous companion identity to the user.

## Non-goals

- Do not require a native realtime speech-to-speech provider.
- Do not flatten every branch into one growing model prompt.
- Do not treat detached work as an in-process subagent owned by a voice socket.
- Do not let model output execute phone, browser, shell, or deployment actions.
- Do not infer publication or other external side effects from a brainstorm.

## Impact

- Builds on `voice-capture-draft-controls`, `context-thread-management`, the
  voice agent router, and the durable work graph.
- Adds a coordinator contract across gateway voice routing, threads, runs, and
  client conversation state.
- Requires latency, interruption, fan-out, recovery, and physical-phone QA.
