# Design: companion voice program coordination

## Program boundary

This change adds a coordination contract. It adds no runtime primitive, API,
store, execution authority, or surface behavior.

One delivery intent links the source request to existing OpenSpec changes,
implementation tickets, runs, candidates, verification, preview, release, and
smoke. The existing intent and release changes remain authoritative for those
records.

## Status rule

Use these evidence states:

- `not_started`: no accepted candidate exists.
- `candidate`: an exact branch, commit, or artifact exists.
- `verified`: the required check passed for that candidate.
- `previewed`: the exact candidate is reachable on an isolated target.
- `installed`: the target device reports the exact artifact.
- `smoked`: the installed or active candidate passed the target behavior check.
- `blocked`: a named condition prevents the next check.
- `stale`: the evidence no longer matches the objective or candidate.

A source checkbox is a source claim. It does not become program evidence until
the matching artifact and check are attached.

## Current reconciliation needs

| Existing change | Current issue | Program treatment |
| --- | --- | --- |
| `define-android-core-product-map` | Its Android spec still requires X and Send controls, while the later accepted gesture change removed them. | Align the spec before accepting UI evidence. Do not restore controls from the stale text. |
| `provider-agnostic-voice-agent-runtime` | Partial STT, diagnosis, recovery, and live surface QA remain open. | Use these open tasks for the first milestone. |
| `streaming-cascaded-voice` | Architecture describes shipped behavior while most tasks remain open. | Build a claims ledger and attach current evidence. Do not reimplement from task state alone. |
| `voice-capture-notebook-ime` | Ask, Note, Coach and browser dictation have partial source claims. Android capture, notebook, derived text, and client admission remain open. | Keep coaching and derived text in this change. |
| companion changes | Web pet motion and proposal-only commands have source claims. Mobile and browser companion presence lacks cross-surface acceptance. | Stage a new companion-presence change after milestone one. |
| intent and principal changes | Linkage and named principal profiles exist, while canonical runtime, worker isolation, repair, verification, and multi-principal joins remain open. | Coordinate milestone one with current workflow. Do not claim autonomous program ownership yet. |
| `voice-intent-completion-loop` | The objective and reducer are proposed. | Use its evidence classes. Keep missing real-phone, browser, and live-provider evidence visible. |
| calendar foundations | Connection policy exists. The generic resolver and a Google Calendar adapter remain open. | Stage a read-only calendar change. |
| macOS surface | Read-only surface work has source claims. Native actions and signed release evidence remain open. | Keep macOS after Android and browser vocabulary stabilizes. |

## Dependency graph

```text
P0 reconcile active branches, source claims, and acceptance contracts
  -> P1 stable diagnosable Android voice turn
       -> P2a browser transcript and voice parity
       -> P2b capture blocks and speaking support
       -> P2c companion presence specification
P2a + P2c
  -> P3 cross-surface companion implementation
P2b
  -> P4 speaking drills and evaluation

I0 canonical intent and delivery linkage
  -> I1 isolated worker and exact-candidate evidence
  -> I2 bounded repair and independent verification
  -> I3 multi-principal join policy
  -> I4 completion reducer over preview, release, and smoke

C0 account connection and capability resolution
  -> C1 read-only calendar day view
  -> C2 day plan from calendar and user-authored commitments
  -> C3 confirmed calendar write proposals

P2 browser and Android vocabulary
  -> M1 macOS parity work
  -> M2 signed and TCC-tested macOS release
```

P0 and I0 may run in parallel when they do not share files. Calendar fixture
work may also run in parallel. Android UI tickets that touch the same overlay
files run in sequence. Integration, independent verification, and release run
after their input lanes join.

## First milestone acceptance

The candidate passes only when all rows bind to the same Android APK, gateway
commit, voice configuration, and acceptance revision.

| Check | Required evidence |
| --- | --- |
| Stable first frame | A physical-phone recording shows the overlay at its saved final position on the first visible frame. It shows no default-position flash or later relocation. |
| Capture authority | Manual QA follows the accepted `voice-first-orb-gestures` contract. No stale X or Send side control owns disposition. |
| Recording privacy | The surface shows a clear active-capture state. A manual turn does not re-arm after completion without a visible continuous-capture grant. Stop ends capture. |
| Transcript stream | Provider and client evidence shows ordered partial text, one canonical final transcript, and bounded time to the first visible partial. |
| Commit | Three consecutive normal turns each produce one commit and one terminal turn. |
| Interruption | One cancel or replacement stops stale playback and records an incomplete prior turn without attaching late output to the new turn. |
| Honest failure | An injected transport or TTS fault produces a visible terminal result and a self-hosted diagnosis with phase, turn identity, provider state, and artifact refs. |
| Audible reply | With voice delivery enabled, endpoint playback reaches a confirmed drain result. If it cannot, the result records a playback failure instead of audible success. |

## First milestone verification

Run these checks against the exact integration candidate:

```sh
cd gateway
npm run check
npm run eval:voice

cd ../android_app
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest assembleDebug
```

Run paid or live provider evaluation only with explicit consent:

```sh
cd gateway
npm run eval:voice -- live
```

Then record:

- gateway git SHA and `/health` voice provider and capability state;
- APK application id, version, byte size, SHA-256, and signer SHA-256;
- phone model and Android version;
- the real-phone acceptance rows above with turn and artifact refs; and
- every failed, dropped, canceled, or timed-out attempt in the sample.

## Preview and release evidence

Build evidence does not prove installation or behavior. Keep these states
separate:

1. `built`: Android checks produced the exact APK.
2. `previewed`: a device-reachable preview serves that digest without moving
   the stable OTA head.
3. `installed`: the phone reports that version and signer.
4. `smoked`: the installed candidate passes the milestone QA.
5. `published`: the authenticated OTA manifest and APK serve the same digest.

Before stable publication, prove rollback, signer continuity, old/new gateway
compatibility, no active recording or voice turn will be interrupted, and
backup plus scratch restore for retained recordings and transcripts.

If the gate passes, use the repo deployment path:

```sh
bash scripts/deploy.sh android
```

If the gate does not pass, keep the preview or artifact and record the blocker.

## Follow-up boundaries

### Companion presence

The later `cross-surface-companion-presence` change should define an optional
actor separate from chat and work history. It should cover drag and bounded
roaming, listening and speaking reactions, reduced motion, hide and restore,
and stale-state behavior. Motion remains packaged data or an inert proposal.
Appearance grants no action authority.

Screen-description pointing waits for fresh surface anchors and local
validation. It does not enter the first companion slice.

### Calendar planning

The later `calendar-planning-intents` change should start with a read-only day
view. It should bind the selected account, timezone, date range, scopes, and
receipt. OAuth credentials stay in the gateway. Android and browser receive
connection handles and results only.

Day-plan synthesis may combine calendar facts with user-authored commitments
after source and freshness rules exist. Event create, update, or delete remains
a separate confirmed proposal with a provider receipt.

### Speaking support

Use `voice-capture-notebook-ime` for literal text, a better phrasing, polished
text, and coaching feedback. Each result keeps its parent transcript and
derivation. A pause suggestion must not commit text, speak over the user, or
start work unless the user enables that behavior.

## Architecture impact

None. The repo already defines delivery intent, companion, account connection,
surface authority, voice evidence, and release evidence. Update
`ARCHITECTURE.md` only when a later implementation adds or changes one of those
boundaries.
