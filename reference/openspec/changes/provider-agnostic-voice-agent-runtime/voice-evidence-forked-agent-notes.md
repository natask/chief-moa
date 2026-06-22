# Voice Evidence And Forked Agent Sessions

## Raw Intent

Source: dictated request attached to the Codex turn on 2026-06-21.

The user wants two things captured before the thread moves on:

- Commit the current verified work instead of leaving it dirty.
- Move beyond "we have a Gemini Live session" toward a product model where
  spoken inputs, assistant outputs, and active agent threads are durable,
  testable, and inspectable.

Key raw phrases to preserve:

- "all the users input voice input should be stored in the server"
- "for the pipeline for testing it should be like i should say something i'll
  tell you exactly what i said"
- "you can just have an audio that gets played through and then you get an audio
  back"
- "test transcription of both ... what was said what was responded and see if it
  matches"
- "when i say something i just want to launch other threads"
- "everything is a fork"
- "the previous what the agent was doing ... doesn't get stopped"
- "each message gets sent to all the agents that are active right now"
- "figures out if it needs to create a new voice agent or ... which voice
  agents"
- "all agents able to manage all my agents"

## Interpretation

The smallest coherent product direction is:

1. Voice turns become replayable evidence records: user audio, expected/observed
   transcript, assistant text, assistant audio, provider/profile versions, and a
   verdict.
2. The voice QA pipeline replays audio through the same gateway voice runtime,
   not only the transcript HTTP route.
3. Every user turn is a possible fork. It may launch a new async `agent_run`
   without stopping already-active runs.
4. Later user turns can be routed to active runs as additional evidence or
   instruction. The gateway manager decides whether to fan out, target one run,
   launch a new fork, or dismiss the turn as irrelevant.
5. The user needs an inspectable "what agents are active and what are they doing"
   status path.

## Acceptance Checks

- A fixture audio file can be replayed through the gateway voice runtime.
- The smoke records observed user transcript, assistant text, assistant audio
  reference, and a pass/fail verdict.
- A new spoken turn can launch a new run with `wait=false` while another run
  remains active.
- A later turn can be linked to one or more active runs without canceling them.
- The gateway can answer which forked runs are active, why they exist, and what
  their latest status is.

## Repo Updates Made

- Updated `ARCHITECTURE.md` with `voice_evidence` and `agent_fork` primitives.
- Updated `provider-agnostic-voice-agent-runtime` proposal, design, specs, and
  tasks with voice replay QA and forked agent routing.
