# Run Goal

## Desired outcome

A user can speak through the same Chief Moa surface, pause without causing a
model response, park a partial capture for later, resume it, cancel it, or send
it. Sent input becomes a durable intent associated with a project and an
inspectable lifecycle. A temporary command such as changing the assistant voice
executes through a bounded tool, records a receipt, completes, and returns the
surface to the interrupted parent intent. Returning to a project yields a
bounded rehydration brief. Operational voice/LLM traces link to the canonical
intent and release without becoming product state.

## Acceptance criteria

1. Pause is distinct from send and never invokes STT/LLM/TTS merely because the
   user stopped speaking.
2. Park stores a resumable draft with source provenance; resume continues the
   same draft; cancel removes or tombstones it deterministically.
3. Explicit new-root input creates a fresh intent root; temporary sub-intents
   preserve and restore their parent.
4. Intents expose status, relationships, evidence, action receipts, and next
   step through authenticated gateway APIs with local fallback and additive
   Postgres support where the existing store boundary permits it.
5. Rehydration produces a bounded, source-linked summary of active priorities,
   recent decisions, open/blocked intents, and meaningful changes.
6. Voice/LLM diagnostics carry intent, project, turn, release, and deployment
   correlation without storing sensitive content in the telemetry projection.
7. Existing legacy gestures and clients remain compatible behind flags or
   additive fields.
8. Narrow and full verification passes, independent auditors return PASS, and
   promotion follows the active safety gate.

## Do not touch

- Provider credentials or `.env` contents.
- Unrelated billing, identity, pet, website, or browser-action behavior.
- Active deployment refs or services until the promotion gate is proven.
- Existing user recordings, transcripts, archives, or databases.

