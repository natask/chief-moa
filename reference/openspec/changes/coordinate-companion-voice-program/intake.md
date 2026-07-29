# Intake: companion voice program

## Source

User direction received on 2026-07-28. The repeated transcript contained the
same requests several times. This file keeps the user's product words without
turning each repetition into another task.

## Raw direction

- "flash, like move, change its location"
- "I really don't like the send and stop buttons"
- "the companion, that should be something that moves around"
- "when I'm speaking, its ears go up"
- "when it responds, its mouth is moving"
- "starts speaking to me and stops"
- "look at any of the logs to be able to see why that failure is happening"
- "see the streaming output like the transcription"
- "move away from turn-based"
- "a phrase that would complete what I just said"
- "become a better speaker, better communicator"
- "What's on my schedule today"
- "takes them from thought, from planning, from research, all the way to
  implementation"
- "launching as many agents as necessary"

## Program outcomes

1. Stop the Android overlay from jumping when it first appears.
2. Keep the capture controls small and clear on mobile.
3. Diagnose voice turns that start speaking and stop.
4. Show useful transcript progress while the user is still speaking.
5. Add speaking support over stable partial and final transcripts.
6. Keep the companion as an optional moving actor outside the work surface.
7. Bring the accepted interaction vocabulary to the browser.
8. Treat macOS as a later native surface.
9. Read the user's calendar and stated commitments for day planning.
10. Carry each approved intent through tickets, agents, verification, preview,
    release, and smoke.

## Clarifications preserved by this program

- "Every microsecond" means the user wants timely continuous feedback. It does
  not require one HTTP call per microsecond.
- The companion should feel alive. The work interface should still work when
  the companion is hidden.
- Listening ears and a speaking mouth are example state reactions. They do not
  grant the companion action authority.
- Calendar reads come before calendar writes.
- Agent fan-out follows ownership and dependency rules. Agent count is not a
  success measure.

## Current working set observed on 2026-07-28

These refs are coordination evidence. They are not proof that a feature is
merged, installed, or smoked.

- integration: `integrate/overlay-redesign-20260727`
- Android overlay: `lane/android-overlay-20260727`
- browser overlay: `lane/browser-overlay-20260727`
- design: `lane/design-overlay-20260727`
- gateway tools: `lane/gateway-tools-20260727`
- workflow and specs: `lane/repo-org-20260727` and
  `lane/openspec-close-20260727`
- Android assistant routes: `lane/android-assistant-20260727`
- related Android fixes: overlay drag, fluidity, polish, and source-size
  ceiling branches

Resume or reconcile these owners before starting a new overlapping lane.
