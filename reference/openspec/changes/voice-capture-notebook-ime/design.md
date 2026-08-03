# Design: Voice Capture Notebook And Android IME

## Core Decision

The canonical primitive is a durable `capture_block`, not a chat message, agent
run, raw audio file, or keyboard insertion. One block may be consumed by several
explicit workflows while preserving one literal source.

```text
Android overlay or Moa IME
  -> capture PCM locally
  -> upload audio and create capture_block
  -> gateway stores audio before provider work
  -> gateway transcribes asynchronously
  -> Android observes literal transcript
  -> user copies, edits, inserts, rewrites, appends, or dispatches
```

This composes existing Moa capabilities instead of building a second voice
stack. Upload completion and transcription completion are distinct states, so a
provider outage cannot turn a successfully stored recording into lost speech.

The browser/macOS accelerator uses the same boundary in a smaller first slice:
the browser requests a transcription-only voice turn and copies the final
literal transcript locally. Reasoning, TTS, categorization, and agent dispatch
are not on its clipboard critical path.

The extension worker is authoritative for the one active browser dictation
session. A page starts capture through the worker, but the active tab is not the
session authority. A global invocation from any tab commits the already-active
dictation instead of starting a competing recorder. All extension pages hydrate
the worker-owned state and may render passive status; only the owning capture
surface handles microphone bytes. Tab navigation and activation therefore do
not redefine the user's session or conversation.

After the canonical transcription-only voice turn is stored and its terminal
event can be delivered, the gateway projects it asynchronously into the product
event substrate:

```text
completed transcription-only voice turn
  -> deterministic literal capture_block
  -> append-only capture.routing.proposed
       route: file_only
       classification: unclassified
       executable: false
       model_used: false
```

The projection retains transcript completeness, configured/observed language
and provider provenance, and a reference to retained turn audio when available.
It is idempotent and reconciled from canonical completed turns on startup. It
does not delay clipboard delivery, infer a topic, mutate a conversation, or
dispatch work. Later reflection, topic extraction, recurring-thought detection,
and user-approved intent routing consume the literal block as derived work.

The first video-led slice keeps the same source-before-derivation boundary but
uses the browser's existing screen-and-microphone WebM note. Explicit Stop is
the user-confirmation boundary: the gateway stores the original bytes and hash,
derives a provider-attributed narration transcript, appends that transcript as
immutable intent source history, and creates one editable `captured` intent.
The side panel shows lifecycle, evidence, retention, transcript provenance,
edits, and event history. It can retry failed transcription or explicitly
delete the raw recording while retaining the transcript and intent history.
No chat response, speech output, agent run, tool request, or dispatch occurs.

## Considered Shapes

### A. Treat every segment as a voice-chat turn

This reuses the most code, but assistant replies, memory, tool routing, and agent
behavior become accidental side effects. It also makes literal dictation harder
to distinguish from model-authored output. Rejected.

### B. Add transcription fields directly to `audio_note`

This is the smallest storage patch, but it makes revisions, explicit dispatch,
IME insertion, and later drill evidence awkward appendages to a storage-only
record. It also blurs the existing invariant that an audio-note upload invokes no
provider. Useful as a migration adapter, not the final product model.

### C. Add `capture_block` above stored audio and voice providers

Selected. The existing `audio_note` remains the retained byte artifact, while a
capture block owns processing state and derived text. It costs one new durable
record and a small state machine, but gives every surface the same semantics and
keeps source, derivation, and action separate.

## Canonical State

A capture block minimally contains:

```text
id, owner_id, session_id, source_surface
created_at, completed_at, duration_ms
audio_note_id, audio_retention_state
transcription_state: queued | transcribing | transcribed | failed | canceled
literal_transcript, transcript_language_evidence, transcript_provider
user_edited_text, revisions[]
dispatches[]
failure_phase, retry_count
```

Revisions are append-only records with `kind` (`user_edit`, `writing_skill`,
`summary`, `coach_feedback`), parent revision, profile/skill version, model
metadata, and text. The literal transcript is immutable provider output; a user
correction becomes a new revision. Deletion/tombstone and retention policy must
cover both audio and derived text.

## Ownership

| Component | Responsibility | State owned |
| --- | --- | --- |
| Android overlay | Fast capture, visible recording state, stop/cancel, drag-to-dismiss, quick block actions | Ephemeral capture buffer and UI state |
| Android full app | Notebook/library, replay, edit, copy/share, retry/delete/export, skill and privacy settings | Local UI cache only |
| Android IME | Sensitive-field gate, voice controls, preview candidates, text commit through `InputConnection`, keyboard switching | Ephemeral candidate and insertion state |
| Gateway capture control | Block lifecycle, idempotent create/finalize/retry, query APIs, authorization | Canonical capture metadata and revisions |
| Gateway audio-note store | Durable raw bytes and retention metadata | Canonical audio artifact |
| Gateway voice providers | STT execution behind current provider registry | No canonical product state |
| Gateway agent runtime | Explicit dispatch from selected block/revision and visible run lifecycle | Agent runs and dispatch receipts |
| Browser extension worker | One active cross-tab dictation owner, lifecycle, and passive state broadcast | Ephemeral active browser capture state |
| Browser pages | Microphone capture for the owning surface and passive rendering for all other views | Ephemeral page UI and audio buffer only |

The Android app and IME store no provider credentials. Model output remains text
or a proposal; it cannot insert into another app or launch an agent without the
owning surface's explicit action.

## Android Surface Design

### Overlay

Capture mode makes press-and-hold create one block on release. Repeating the
gesture creates sibling blocks and leaves a compact capture tray showing the
latest states. The orb remains draggable. While dragging, a bottom-center
`Hide orb` target appears; dropping on it asks for or uses a reversible hide
action. Permanent service disable stays in the full app/settings.

Do not assign double-, triple-, and four-tap gestures to media or agent types.
The user states note/coaching intent conversationally; the surface may show the
active behavior as status but must not expose a mode selector. Multi-clicks are
reserved for interruption, branching, and chat mechanics.

### Full App Notebook

The notebook lists capture blocks newest-first and supports multi-select. A
detail view shows audio playback, literal transcript, user edit, revisions,
language/provider evidence, processing failures, and dispatch/run links. Deep
history remains out of the overlay.

### IME

Add an `InputMethodService` with the required `BIND_INPUT_METHOD` declaration
and input-method metadata. The service inspects `EditorInfo.inputType`, refuses
network capture and retention for password/sensitive variants, and uses the
active `InputConnection.commitText(...)` to deliver selected text. It never uses
accessibility to type into the destination application.

The first IME is intentionally small:

- hold/tap microphone;
- live/final transcript preview;
- literal / selected writing-style candidate;
- commit, cancel, backspace, space, punctuation, and enter/action;
- switch-to-next-keyboard affordance;
- English and Amharic voice/language selector.

A complete Amharic character keyboard is a later bounded product change after
the voice-first IME proves activation, insertion, privacy, latency, and recovery.

## Writing Skills And Drills

A writing skill is a versioned gateway profile that transforms a selected text
revision under a named intent such as `concise message`, `my professional
voice`, or `clean up without changing meaning`. The result is a candidate and
never overwrites the literal transcript or user edit automatically.

A future drill consumes opted-in examples and produces separately labeled
feedback. Training corpora, scoring rubrics, consent, deletion, and evaluation
evidence require their own change; the capture notebook should merely preserve
the provenance needed later.

## Failure Behavior

- Upload fails: retain bytes locally, show unsynced state, retry idempotently.
- Upload succeeds and STT fails: preserve audio, mark the block retryable, and
  never report the note as lost.
- IME loses focus while recording: cancel insertion, finish or cancel capture
  according to the visible user choice, and never insert into a new field.
- Destination field changes before commit: bind the candidate to the current
  editor session and require reconfirmation.
- Rewrite fails: retain literal/user-edited text and expose retry.
- Dispatch fails: preserve the block and store a failed dispatch receipt.
- Offline: create a local pending block if retention is enabled; do not imply it
  has reached the gateway.

## Privacy And Monetization

Keyboard and transcript content are exceptionally sensitive. Do not place ads,
tracking SDKs, or content-derived ad selection inside the IME, capture tray, or
notebook detail view. If the product is monetized, prefer a paid tier,
usage-based transcription, or non-content-based sponsorship outside the input
surface. Any future ad model needs a separate privacy/threat-model decision.

## Rollout

1. Reconcile shipped voice/audio-note work and create focused acceptance tests.
2. Project completed browser dictation turns into literal capture blocks and
   inert file-only routing proposals without changing the clipboard path.
3. Add the full audio-first capture-block lifecycle behind the gateway with
   migration/adaptation from audio notes; deploy additively so old clients
   continue working.
4. Add Android capture result and notebook list/detail; publish an OTA artifact
   only after loss/retry and phone QA pass.
5. Add writing-skill candidates without automatic replacement.
6. Add the IME in an opt-in build path and verify sensitive-field behavior on a
   physical device.
7. Add explicit block dispatch and multi-select dispatch.
8. Verify the explicit browser video-led intent path, then consider additional
   media gestures, Amharic character layout, and drills as separate changes.

## Verification Strategy

- Gateway: deterministic create/upload/transcribe/retry/query/delete fixtures;
  assert raw audio is stored before STT and provider failure cannot delete it.
- Browser projection: assert one active worker-owned dictation across tabs,
  late-tab hydration, commit from a different tab, terminal owner lifecycle, and
  no page identity in gateway heartbeat metadata.
- Gateway projection: assert deterministic block identity, exact bounded literal
  text and provenance, one idempotent non-executable file-only proposal, query
  behavior, and startup reconciliation.
- Android unit: capture state reducer, editor sensitivity classifier, insertion
  session binding, gesture/drop-target decisions.
- Android build: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew test assembleDebug`.
- Phone QA: three sequential blocks, offline recovery, background/foreground,
  orb drag/hide, normal field insertion, focus change, password refusal, English,
  Amharic, and mixed speech.
- Promotion: additive state compatibility, backup/restore evidence, no active
  recording or transcription interrupted, OTA rollback known, then smoke the
  promoted gateway and installed Android build.
