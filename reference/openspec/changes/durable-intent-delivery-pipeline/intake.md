# Intake: Durable Delivery And Simpler Capture Surfaces

## Source

Current user direction, 2026-07-23. This file preserves the product nouns and
uncertainty that must not live only in a chat session.

## Delivery Problem

The standard path must accept an idea, problem, solution, or intent and carry it
through durable capture, architecture, tickets, implementation, QA, a
user-testable candidate, promotion, and post-promotion smoke. The user should be
able to see the state and evidence without reconstructing it from agent chats.

The repository already has intent, work-history, work-graph, agent-run, artifact,
preview, and release records. They currently lack one canonical linkage and
projection.

## Error And Feature Evidence

- The user wants to say “I’m about to report an error” and attach their
  description plus recent interaction evidence.
- A desired future capture path keeps a bounded rolling window, such as the last
  30 seconds, and lets the user attach the resulting video and action history.
- Video, screen, file, and model-derived summaries remain evidence. They never
  become repository, execution, or promotion authority.
- Evidence must persist and be processable by a multimodal model without
  replacing the raw user report.

## Surface Problems

- Android’s orb should remain low-alpha, movable, and visible without covering
  content.
- Dragging while speaking must not interrupt, cancel, or send speech. The user
  must be able to reposition the control while continuing the same capture.
- Multi-tap mode selection is too difficult to remember. Speech, literal
  dictation, and typed input need explicit visible entry points.
- The user needs distinct mute and interrupt controls for assistant speech.
- Recording should not end at a five-minute client limit. It needs durable
  chunking, explicit stop/play, and visible storage/provider failure.
- Every recording attempt should appear in timestamped history even when its
  transcript is empty or failed. The user needs replay, retry-transcript,
  rewrite, and record-again actions with distinct meanings.
- A visible Attach action should accept file/video evidence. Drag/drop may be an
  accelerator, not the only path.
- Dictation should replace the clipboard with a clear receipt. The previous
  clipboard value should not be retained by default.
- Android and browser should share the visible interaction vocabulary. macOS
  should become a practical Wispr Flow replacement through explicit global
  dictation invocation, literal transcript, clipboard output, and history.
- Technical recognition bias should reuse bounded speaker context now and add a
  project glossary only after corpus-based evaluation.

## First Authorized Implementation

Implement the canonical linkage spine only:

```text
current user-authored work turn
  -> delivery intent
  -> one linked work task
  -> one linked queued run proposal
  -> inspectable delivery projection
```

Retrying the same turn must create no duplicates. This first slice launches no
worker, edits no code on behalf of the runtime, and requests no deployment.

The surface redesign and rolling video buffer remain separately ticketed changes
because they cross Android, browser, macOS, gateway, privacy, storage, and
release lanes.
