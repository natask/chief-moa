# Mobile Voice Intent Audit — 2026-07-14

## Purpose

Read-only reconstruction of user-authored mobile voice turns retained on the
production VPS during the most recent recorded hour. This is an evidence and
intent-tracking artifact, not implementation authorization.

Production source inspected:

- host: Chief Moa DigitalOcean gateway;
- user scope: the durable shared user session;
- recorded window: 2026-07-14 07:39–08:39 UTC (00:39–01:39 PDT);
- source surface: Android overlay;
- canonical records: `/data/voice-turns/<shared-user>/` and matching retained
  PCM under `/data/voice-sessions/<shared-user>/`.

No service, file, record, configuration, or deployment was changed during the
audit.

## Capture Findings

- The VPS holds 491 voice-turn records for the shared user from July 6 through
  July 14: 281 gateway-STT, 154 client-STT, and 56 synthetic failed-transcript
  records.
- It holds 367 user PCM files, of which 8 are zero bytes, plus 201 assistant PCM
  files. Raw audio therefore exists for most but not all retained turns.
- There is one separate record-mode audio note. The recent implementation ideas
  below were spoken through voice chat, not stored as `audio_note` records.
- The last hour contains five substantive product/architecture notes. Two were
  duplicated as both STT and client-STT records with the same transcript.
- Several nearby turns retained non-empty PCM but only the synthetic transcript
  `Voice captured.`. Those turns cannot be safely converted into intent from the
  stored transcript alone.
- The long notes about voice-note implementation and voice reliability were
  answered with unrelated voice-sampler output. Capture succeeded; intent
  routing did not.

PCM durations below are derived from retained byte counts using the recorded
16 kHz, mono, 16-bit format. They are evidence that the audio exists, not a new
transcription or a claim that the existing STT is exact.

## Recovered Intent Ledger

### I1 — Voice-note inbox that can feed implementation

Evidence:

- primary turn: `turn_deb7ca4e-a45d-45f7-8eea-407fce8afcb2`;
- duplicate client-STT record:
  `turn_5ac60d77-bea0-4d23-b7a2-ef4c95a8967d`;
- captured at 2026-07-14 08:10 UTC;
- retained user PCM: 3,016,960 bytes, approximately 94.3 seconds;
- follow-up: `turn_2299f641-4c1d-419a-8797-4705bf1c4721` asks to reinterpret
  speeches given in the past.

Resolved intent:

- Use the app to leave voice notes.
- Later see or pull those notes on the execution machine.
- Review their transcripts and/or play the original audio.
- Turn selected notes into implementation work.
- Eventually develop more of A.G. directly through speech.

Current status: `partially_satisfied`.

- Raw record-mode audio-note capture, storage, list, and retrieval exist.
- Ordinary mobile voice turns also retain transcripts and usually raw PCM.
- There is no unified user-facing note/turn inbox, transcript/audio review,
  deduplication, selection, or “turn this into tracked work” flow.
- The immediate response incorrectly launched/advertised the voice sampler, so
  no implementation task was created from this note.

### I2 — Screenshot/current-app evidence for modification requests

Evidence:

- same primary and duplicate turns as I1;
- current-session clarification: the app itself should accept screenshots and
  modification feedback because it already knows the app, project, version, and
  surrounding context.

Resolved intent:

- Capture or attach a screenshot/error from the app being discussed.
- Avoid forcing the user to restate the target application, project, version,
  and current context.
- Submit the modification request from the same A.G. app when possible.
- Explore a separate “local master org” application only as a credible
  alternative, not the assumed default.

Current status: `partially_satisfied` at the context primitive, `new` at the
product workflow.

- Android already has accessibility-derived current-screen context and owns
  local screen/permission policy.
- The browser agent has bounded screenshot evidence, but that is not an Android
  modification-request inbox.
- No complete Android screenshot artifact → project/version resolution →
  reviewable change request → execution-worker flow is established.

Architecture exploration is being handled as its own thread, as requested.

### I3 — Separate thought-partner behavior from intent-executor behavior

Evidence:

- turn: `turn_c1630130-4d57-4c7c-a3be-97e23ced09a5`;
- captured at 2026-07-14 08:17 UTC;
- retained user PCM: 4,916,480 bytes, approximately 153.6 seconds.

Resolved intent:

- In exploratory thinking, challenge the user's claims, reason from first
  principles, and try to falsify them rather than agree reflexively.
- In a clear execution request, act concisely and avoid unsolicited discursive
  coaching.
- Keep address/tone (“master”) independent from epistemic behavior; respectful
  wording must not bias the model toward agreement.

Current status: `partially_satisfied`.

- Runtime profiles/personas and intent classification exist.
- The explicit two-mode epistemic contract and its verification cases are not
  recorded as an accepted product behavior.
- The immediate assistant response contradicted the requested behavior by
  agreeing and summarizing instead of challenging or recording the distinction.

### I4 — Voice reliability, transparent pipeline, and language controls

Evidence:

- primary turn: `turn_1fe2ba88-a94a-4e0d-8ede-6d2485461439`;
- duplicate client-STT record:
  `turn_efb10de9-182b-41fa-a759-a48586b7b2ef`;
- captured at 2026-07-14 08:21 UTC;
- retained user PCM: 1,361,280 bytes, approximately 42.5 seconds.

Resolved intent:

- Fix repeated `voice connection dropped / voice turn failed` behavior.
- Make the active VPS voice pipeline understandable.
- For language switching, change only the necessary language behavior instead
  of perturbing unrelated voice/profile settings.

Current status: `partially_satisfied`, with current failure evidence.

- The production health endpoint identifies the current cascaded path as Chirp
  3 STT → gateway reasoning → Gemini TTS.
- Voice diagnostic and provider-independent language-state contracts exist.
- The shared history contains 56 synthetic failed-transcript records overall,
  including several during this hour with non-empty retained PCM.
- The note was again routed to voice-sampler output rather than tracked as a
  reliability issue.

### I5 — Recovery must not depend on the failing model or release

Evidence:

- primary turn: `turn_9b730d20-3739-4519-867a-a016f9bf8f62`;
- duplicate client-STT record:
  `turn_799a4118-582b-4418-8374-2ed62e2d499c`;
- captured at 2026-07-14 08:22 UTC;
- retained user PCM: 4,510,720 bytes, approximately 141.0 seconds.

Resolved intent:

- A bad app implementation must leave a known launchable version and a way back.
- Upgrade/downgrade and recovery paths must not require the LLM that may be
  failing.
- A failed model endpoint should fall back through deterministic health checks
  far enough to regain a diagnostic/control surface.
- Single/double-click thread/session behavior should keep ordinary conversation
  simple, but is secondary to recovery safety in this note.

Current status: `partially_satisfied`.

- OTA/release selection, rollback metadata, backup/restore gates, and staged
  promotion contracts exist.
- Voice providers are registry-based and selectable.
- A proven, model-independent client recovery plane combining last-known-good
  app launch, deterministic gateway/model health selection, and user-visible
  diagnosis is not yet one accepted end-to-end contract.
- The note was incorrectly routed to the voice sampler, so it produced no task.

### I6 — Consumer surface with an extensible/enterprise substrate

Evidence:

- turn: `turn_bd5476d8-2465-425e-afa6-96fe3ffa160a`;
- captured at 2026-07-14 08:13 UTC;
- retained user PCM: 5,229,440 bytes, approximately 163.4 seconds.

Resolved intent:

- Build an excellent consumer product while keeping the system general enough
  to become a standard others and enterprises can build on.
- Reduce the cost of carrying a real intent through to completion.
- An ambient agent can help a curious user identify worthwhile questions, but
  cannot manufacture intent for someone who has none.

Current status: `product_direction`, not a bounded implementation ticket.

This should constrain architecture choices but needs further alignment before
it becomes a build task.

## Recommended Architecture Order

1. Build the read-only voice-note/turn inbox first. It should list original
   audio, transcript source/quality, duplicates, routing result, and linked work.
2. Add explicit selection: “track this,” “correct transcript,” “play audio,” and
   “propose implementation.” Selection creates an evidence-backed proposal, not
   an automatic run.
3. Resolve and align I3, I4, and I5 as separate OpenSpec changes/tickets. They
   have different owners and verification paths.
4. Design the screenshot/current-app modification flow as a separate
   cross-surface architecture thread, then connect its approved change requests
   to the same tracked-work inbox.
5. Only after the inbox proves useful, consider background intent mining.

## First Observable Slice

From the Android full app, show the last 50 genuine user voice items with:

- one row per logical utterance after duplicate collapse;
- timestamp, duration, transcript, transcript source, and quality/failure state;
- a working play-original-audio action when retained PCM exists;
- routing result (chat, sampler, agent/work request, failure);
- linked task/run status when one exists;
- no model call and no work launch merely from opening the list.

This slice makes the retained evidence visible and correctable before asking the
system to infer or execute implementation.
