# Global Voice Input Direction (2026-07-14)

## Status

Proposed for product and architecture alignment. This note records the user's
direction and the smallest coherent architecture; it does not authorize product
implementation or active promotion.

## Linearized Intent

1. Speaking must be a dependable way to create text, not a short voice-command
   mode. The product must not impose a user-visible recording deadline.
2. Stopping or sending must produce immediate tactile evidence. A later network,
   transcription, rewrite, or routing failure must not make the capture feel
   unsent or lose the audio.
3. Literal transcription must be accurate and repeatable across English,
   Amharic, and code-switched speech. Rewriting, translation, and intent
   interpretation are separate derived operations.
4. Named writing skills should turn a literal capture into message candidates in
   the user's preferred voice without destroying the literal source.
5. Android should expose the capability wherever text can be entered through a
   real IME. Browser and desktop surfaces should be globally invocable through
   their native command mechanisms. Apple surfaces require their own bounded
   design rather than assuming Android IME behavior transfers directly.
6. Aggie should become the general intent surface: capture one user expression,
   preserve it canonically, resolve it against projects and active work, and
   explicitly dispatch the chosen work.
7. Multiple agents may explore independent interpretations or lanes, but fan-out
   is an observable routing decision with budgets, relevance dismissal, run IDs,
   and a final synthesis. Receiving a message alone must not silently create
   unbounded work.

## Primary Product Invariant

Once the user receives the local send acknowledgement, Moa has durably accepted
the complete capture on that device. Provider limits, socket reconnects, app
backgrounding, or later processing failures may delay derived text, but cannot
erase the accepted audio or falsely report it as delivered to the gateway.

## Selected Shape

Use one resumable logical `capture_block` backed by bounded local audio chunks.
"No time limit" is a product contract, not one unbounded in-memory buffer or one
provider stream. The client rolls chunks and records an append-only local
manifest for as long as storage and OS recording permission remain available.
It uploads chunks idempotently while recording when possible and finalizes the
logical block only after the user stops.

```text
press/toggle record
  -> local durable chunk spool begins
  -> optional idempotent background chunk upload
  -> user stops/sends
  -> local manifest is sealed + send haptic fires
  -> gateway acknowledges complete block (delivery haptic/state)
  -> Chirp streams/segments literal transcription
  -> optional Gemini comparison or recovery candidate
  -> user selects literal/edit/rewrite
  -> surface inserts, sends, asks, or explicitly dispatches
```

The UI distinguishes four receipts:

- `captured`: sealed locally; immediate send haptic is allowed.
- `delivered`: every chunk and the manifest are acknowledged by the gateway.
- `processed`: literal transcript is available, or a visible retryable failure is
  attached to the retained audio.
- `acted`: selected text was inserted/sent or work was explicitly dispatched.

No earlier state may be presented as a later one. A haptic pattern should be
short and stable: one firm acknowledgement for local capture, with visible state
for gateway delivery rather than repeated success-like buzzing.

## Speech Recognition Decision

Chirp 3 remains the primary literal STT candidate because it supports streaming
partials and is an ASR-specific boundary. Gemini 3.5 Flash remains a completed-
audio comparison, semantic recovery, or arbitration candidate; it must not own
the live transcript, project context, tool loop, or agent launch decision.

Temperature zero is already part of the Gemini evaluator and did not make its
output deterministic on the five protected captures. Repeatability therefore
must be measured empirically, not inferred from sampling configuration.

The next comparison must use a human-verified ground-truth corpus. Prior provider
transcripts are evidence, not truth. The matrix should stratify:

- English, Amharic, and both code-switch directions;
- short embedded foreign-language tokens and longer switched clauses;
- quiet, street, car, headset, distance, and overlapping-noise conditions;
- short messages, 30-second notes, 5-minute stream-rollover boundaries, and
  long logical captures assembled from multiple chunks;
- natural pauses, false starts, punctuation, proper nouns, numbers, URLs, and
  message-editing language;
- at least ten identical trials per provider/configuration for repeatability.

Report word and character error rate only against verified references. Also
report leading/trailing audio loss, language-span recall, script violations,
semantic omissions, exact-repeat rate, latency to first partial, finalization
latency, provider errors, and estimated cost. Preserve per-trial outputs and
provenance; never collapse them into a single subjective winner.

## Surface Ownership

| Surface | Entry and delivery responsibility | Constraint |
| --- | --- | --- |
| Android overlay | Fast global capture and durable local spool | Overlay stays small; notebook owns recovery/history |
| Android IME | Voice candidate preview and `InputConnection` commit | Fail closed for password/sensitive editors |
| Browser extension | Shortcut/mark invocation and focused-field insertion proposal | Browser owns local DOM/CDP execution and receipt |
| macOS native surface | Global shortcut/menu-bar capture and explicit insertion/paste action | Requires a native shell and local permission design |
| iOS containing app/keyboard | Candidate selection and supported text insertion | Third-party keyboards are unavailable in some fields/apps; microphone and network behavior need a separate spike |
| Gateway | Capture manifests, provider routing, literal/revision provenance, project intent resolution, run records | No device-local insertion or hidden action authority |
| Execution machine | Bounded research/coding lanes and synthesis | Runs only after explicit or user-approved routing policy |

## Intent Routing And Multi-Agent Work

Do not make "launch multiple agents for every message" the ingestion primitive.
First store one canonical intent envelope containing the literal capture,
selected revision, source, project candidates, and evidence refs. A deterministic
router then returns a visible plan:

1. attach to an active run or project;
2. answer directly;
3. open one bounded work lane; or
4. propose a multi-lane exploration with named questions and synthesis.

An approved multi-lane job creates child run records with independent budgets,
relevance dismissal, and receipts, followed by one synthesis node. This preserves
parallel exploration without multiplying cost or acting on a bad transcript.

## Smallest Coherent Slices

1. Expand the protected, human-verified speech corpus and build one reproducible
   Chirp-versus-Gemini trial runner. This is evaluation only.
2. Implement resumable local chunk spooling plus the four-state receipt contract
   on Android capture mode. Prove a forced provider/network failure cannot lose a
   locally acknowledged capture.
3. Complete the existing `capture_block` gateway slice and Android notebook.
4. Add named rewrite candidates while preserving the literal transcript.
5. Add the Android IME and prove sensitive-field refusal and focused-field
   binding on physical devices.
6. Add explicit project routing and bounded multi-lane dispatch over selected
   capture revisions.
7. Run separate macOS and iOS native-surface spikes; do not block the Android
   product on cross-platform parity.

## Alignment Decisions Needed

1. Is the first product the Android capture/notebook/IME loop, with browser and
   Apple surfaces following, or must the first release be cross-platform?
2. Should the first haptic mean "safely captured on this device" (recommended),
   with delivery shown separately, or should haptic wait for gateway delivery?
3. Should multi-agent dispatch remain explicit per message (recommended), or
   should the user enable a persistent policy that auto-approves bounded fan-out
   for selected projects?

## Current External Constraints

- Chirp 3 supports streaming recognition; Google's documented streaming limit is
  five minutes, so a user-unlimited capture needs stream rollover or batch/chunk
  processing rather than one permanent provider stream.
- Google documents synchronous recognition for audio under one minute and batch
  recognition for longer audio, generally up to one hour.
- Android officially supports system-wide IMEs built with
  `InputMethodService`; text is delivered through `InputConnection`, and
  password content must not be displayed or stored.
- Apple custom keyboards are not available in secure fields and may be disabled
  by host apps. Apple keyboard/microphone behavior must be verified against the
  current extension APIs before promising iPhone parity.

Primary references:

- https://docs.cloud.google.com/speech-to-text/v2/docs/chirp-model
- https://docs.cloud.google.com/speech-to-text/docs/troubleshooting
- https://developer.android.com/develop/ui/views/touch-and-input/creating-input-method
- https://developer.apple.com/documentation/uikit/creating-a-custom-keyboard
- https://developer.apple.com/documentation/uikit/configuring-a-custom-keyboard-interface
