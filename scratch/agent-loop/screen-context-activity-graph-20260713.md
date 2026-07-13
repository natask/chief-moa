# Screen context / activity graph direction — 2026-07-13

Source: user voice note 2026-07-13 (`__LOG__.md`). Direction capture, not a
committed build plan.

## What the user wants

The voice agent should know what the user was doing and which projects they
are working on, cheaply — so that spoken intents land with the right context
("make forward progress on X" without re-explaining X).

Two known approaches, both considered valid:

1. **Capture everything** (Rewind / ScreenPipe style): continuous screen (+
   audio) recording, index later, search backward. Pros: nothing lost, dumb
   capture. Cons: battery/storage/privacy cost, and most of it is noise — "a
   lot of unnecessary information"; even with infinite inference, information
   the user cares about is still lost in the reconstruction.
2. **Capture what matters** (project-centric): maintain an explicit set of
   projects/intents the user cares about, and capture/attach only information
   that extends those. "You first have to know what I care about to be able to
   expand the set of information I care about." This is the direction the
   existing intent/thread machinery (context-thread-management, voice intent
   routing, gbrain) already points at.

With infinite resources you'd do both and intersect them into a backward-
introspectable **activity graph** (what was I doing, per project, over time).

## Hard constraint from the user

**Do not build a separate product.** Either (a) unify/reuse existing solutions
(ScreenPipe is the named example; it is open source, local-first, has an API,
and already solves capture+OCR+search), (b) find a path that leverages what's
already built, or (c) rebuild only what does not exist. The inspiration
product was a browser-based personal assistant that snapshots open windows and
uses them to make forward progress on the user's project — the browser is the
first surface where the core ideas should land, with Apple/macOS and mobile
variants using native capabilities later.

## Cheapest coherent wedge (proposal)

1. Browser first: the extension already has tab/page access. On each voice
   turn (or on demand), capture lightweight window/tab context — titles, URLs,
   selection, optionally a screenshot of the active tab — as *evidence*
   attached to the turn (screen context is evidence, not instruction, per
   AGENTS.md).
2. Project registry: a small gateway-owned list of active projects/intents
   (seeded from gbrain + threads). Each captured context snapshot is filed
   against a project by a cheap classifier, building the activity graph
   incrementally instead of by bulk reprocessing.
3. Reuse ScreenPipe for the capture-everything lane on desktop *if/when
   wanted*: run it locally, query its API from the gateway/agent instead of
   building our own recorder. Evaluate before writing any capture code.
4. Backward introspection = query the graph by project/time from the voice
   agent ("what was I doing on ketera yesterday?").

## Open questions (user decisions)

- Which surface first for screenshots: extension-only, or macOS native too?
- Retention/privacy posture for captured frames (local-only vs gateway
  storage) — recordings rule in AGENTS.md applies (backup/restore evidence).
- Adopt ScreenPipe as a dependency vs API-integrate vs skip entirely.

## Related

- `reference/openspec/changes/context-thread-management`
- `reference/scratch/agent-loop/spoken-intent-routing-wedge-20260702.md`
- `reference/scratch/agent-loop/voice-fetch-hosted-agent-control-plane-20260703.md`
