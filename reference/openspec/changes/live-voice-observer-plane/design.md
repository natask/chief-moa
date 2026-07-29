# Design: Live Voice Observer Plane

## 1. The Plug-In Contract

### 1.1 Registration

An observer is registered once, at gateway startup, into a per-session plane.

```js
plane.register({
  id: "speech-coach",              // stable, unique, [a-z0-9-], <= 40 chars
  version: 1,                      // observer contract version; 1 is the only one
  priority: 10,                    // integer tie-break only, never a score
  triggers: ["pause"],             // subset of: partial | final | pause | vad_stop | floor_change | tick
  minStability: 0.7,               // 0..1; frames below this never reach observe()
  minIntervalMs: 6000,             // per turn, since this observer's last invocation
  maxProposalsPerTurn: 3,
  maxLatencyMs: 900,               // hard budget for one observe() call
  languages: ["*"],                // BCP-47 prefixes, or "*"
  partialSafe: false,              // may this observer's output be spoken from a partial?
  maxDelivery: "overlay",          // this observer's OWN ceiling on the ladder
  allowDeferFallback: true,        // demote to a bubble instead of dropping when it loses
  observe,                         // (frame, { signal }) -> Proposal | null
});
```

Registration is validated and frozen. An invalid registration throws at startup,
not at speech time. `maxDelivery` is a ceiling the observer sets on itself; the
arbiter and the user policy can only lower it further.

### 1.2 What `observe()` receives

One frozen `ObservationFrame`. It contains no tools, no profile, no credentials,
no conversation history beyond a single prior turn, and no way to reach the
gateway.

```js
{
  version: "moa.voice-observation.v1",
  session_id, branch_id, turn_id,
  trigger: "pause",
  sequence: 7,                       // monotonic per turn

  transcript: {
    revision: 42,                    // the plane's transcript revision (as in phrase assist)
    stable_text: "...",              // the watermarked prefix — safe to reason over
    stable_revision: 41,             // revision at which stable_text last changed
    tail_text: "...",                // the unstable remainder — NEVER concatenated in
    chars: 184, words: 33,
  },

  stability: {
    watermark: 0.82,                 // stable_chars / total_chars, 0..1
    stable_ratio: 0.82,
    revisions_since_stable_change: 2,
    last_change_ms: 640,
  },

  vad: { state: "pause", pause_ms: 420, speech_ms: 7300 },
  timing: { turn_elapsed_ms: 7920, since_last_frame_ms: 610 },
  language: { input_codes: ["en-US"], reply_code: "en-US", scripts: ["latin"] },

  floor: {
    holder: "user",                  // user | assistant | idle
    assistant_speaking: false,
    reply_in_flight: false,          // turn is committed/playback or an audio stream is open
    ms_since_reply_end: 18400,
  },

  prior_turn: { turn_id, user_text, assistant_text } | null,
  budget: { latency_ms: 900, proposals_remaining: 2 },
}
```

`stable_text` and `tail_text` are deliberately separate fields. An observer that
wants the whole utterance must opt in by concatenating them itself, and by doing
so it forfeits audible delivery (§4).

### 1.3 Invocation cadence

Frames are produced on transcript partials, transcript finals, client-reported
VAD transitions, floor changes, and a 2s idle tick. The plane then applies a
**pre-filter** before any observer code runs:

1. observer enabled by policy, not quarantined, `proposalsRemaining > 0`
2. `frame.trigger ∈ observer.triggers`
3. `frame.stability.watermark >= observer.minStability`
4. `frame.language` matches `observer.languages`
5. `now - lastInvokedAt >= observer.minIntervalMs`
6. `frame.transcript.stable_revision !== observer.lastSeenStableRevision`
7. the transcript-quality guard accepts `stable_text` for the turn's languages

Only a frame passing all seven reaches `observe()`. This is what makes declining
cheap: for a typical turn the coach's `observe()` runs one to three times while
the plane builds and discards dozens of frames. An observer that wants to decline
inside its own code returns `null`, which is also free — no proposal, no receipt
beyond a counter.

At most **one** `observe()` per observer is in flight at a time. A frame arriving
while one is in flight replaces the pending frame rather than queuing, so a slow
observer sees the newest state and never accumulates a backlog.

### 1.4 Why an observer cannot block the turn

This is structural, not advisory:

- The plane's `note()` entry point is **synchronous and returns void**. It builds
  the frame, pre-filters, and starts dispatch on a detached promise. The voice
  turn's `onTranscriptPartial` / `onTranscriptFinal` handlers do not `await` any
  observer.
- Each `observe()` runs under `Promise.race` against `maxLatencyMs` and an
  `AbortSignal`. On timeout the plane records `timeout` and abandons the result;
  a late resolution is discarded.
- A throw is caught, recorded as `error`, and counted. Three failures
  (`timeout` or `error`) in one turn quarantine the observer for the rest of the
  session. Quarantine is recorded, content-free.
- The commit path, the STT stage, the reasoner, and TTS have no code path that
  reads observer state. If the entire plane were deleted mid-turn, the turn would
  complete identically.

An observer that blocks is therefore a bug in the observer, and it degrades only
that observer.

### 1.5 Latency budget

| Stage | Budget |
| --- | --- |
| frame build + pre-filter (per frame, per observer) | < 1 ms, synchronous |
| `observe()` soft target | 250 ms |
| `observe()` hard cap | `maxLatencyMs`, default 250 ms, max 2000 ms |
| arbitration window | 120 ms after the first eligible proposal |
| arbiter decision | < 1 ms |
| proposal end-to-end (frame -> delivery event) | `maxLatencyMs + 120 ms` |

An observer that wants to speak beside live speech has to be fast, because
`overlay` audio is only useful while the user is still on the same thought. The
default 250 ms cap is chosen to make that explicit; the coach raises it to 900 ms
and accepts that its proposals will more often be stale on arrival.

## 2. The Delivery Arbiter

### 2.1 The proposal

```js
{
  version: "moa.voice-proposal.v1",
  observer_id, proposal_id,
  mode_request: "overlay",          // overlay | interject | defer
  text: "...",                      // <= 140 chars, single line, always present
  speech_text: "...",               // optional distinct spoken form, <= 140 chars
  urgency: 0.3,                     // 0..1, "how much does waiting cost"
  confidence: 0.7,                  // 0..1, "how sure am I this is right"
  transcript_revision: 42,
  stable_revision: 41,
  stable_digest: "sha256:...",      // digest of the stable_text it reasoned over
  stability_watermark: 0.82,
  ttl_ms: 4000,
  reason_code: "phrasing",
}
```

`text` is mandatory even for `interject`, because every mode must be able to
degrade to a bubble.

### 2.2 The three modes, exactly

**`overlay`** — audible and visible beside the user's speech.
- The user keeps the floor. Capture is not stopped, the turn is not committed,
  the transcript is not altered.
- Audio plays through the hosted TTS path at reduced gain. Never through Android
  local `TextToSpeech`; if hosted TTS is unavailable the delivery degrades to
  `defer` rather than falling back to a local voice.
- Emitted alongside a bubble carrying the same `text`, so the delivery is not
  lost if the user talks over it.
- Does not enter canonical conversation history as an assistant turn. It is
  recorded as an `observer_delivery` receipt on the turn.
- Eligible only when `floor.holder === "user"` and `reply_in_flight === false`.

**`interject`** — takes the floor, the user is expected to stop.
- Emits `voice_floor_yield` before the audio. The client stops presenting
  capture as the active thing and plays at full gain.
- **It does not cancel the user's turn.** Capture continues, the transcript keeps
  accumulating, and the user's turn commits normally when they finish. This
  distinguishes an interjection from a barge-in: an interjection changes who is
  talking, not which turn is live.
- Requires `floor.holder === "user"`, `reply_in_flight === false`, a proposal
  computed from stable text, and both the observer ceiling and the user policy
  ceiling at `interject`.
- Never available on a non-Latin-script turn (§4.4).

**`defer`** — never audio.
- A bubble or a notification carrying `text`. No TTS call is made at all.
- Always available. Every mode degrades into this one.
- A deferred delivery may be retracted (§4.3); spoken audio cannot.

**`drop`** — a content-free receipt and nothing else. Used for ineligible,
expired, superseded, revised, and policy-forbidden proposals.

### 2.3 Ranking

Proposals arriving within a 120 ms **arbitration window** are decided together.
The window opens on the first eligible proposal for a turn and is not extended by
later arrivals.

Step 1 — **eligibility gate**. Applied before any scoring. A proposal is dropped,
with the recorded reason, if any of these fail:

| Check | Drop reason |
| --- | --- |
| observer enabled by policy and not quarantined | `policy_disabled` |
| `now < proposed_at + ttl_ms` | `expired` |
| `stable_digest` matches the turn's current stable prefix digest | `revised` |
| `currentRevision - transcript_revision <= maxRevisionDrift` (default 1) | `stale` |
| turn status is still `recording` | `inactive` |
| `text` non-empty after normalization | `empty` |
| transcript-quality guard accepts the current stable text | `quality_rejected` |

Step 2 — **score** the survivors:

```
score = 0.5 * urgency + 0.3 * confidence + 0.2 * stability_watermark
```

Urgency dominates because the cost of a late delivery is what makes a delivery
worthless; confidence second because a wrong utterance is expensive; stability
third because it is already a hard gate above, and here only breaks near-ties.

Step 3 — **total order**, so the outcome is deterministic and testable. Ties in
`score` (compared at 6 decimal places) break by, in order: higher registration
`priority`, earlier `proposed_at`, then lexicographic `observer_id`.

Step 4 — **one audible winner per window.** The top-ranked proposal is the only
one that may be delivered above `defer`. Every other surviving proposal is
delivered as `defer` if its observer set `allowDeferFallback`, and dropped as
`superseded` otherwise. Two observers firing at once therefore produce at most
one voice and any number of bubbles — never two voices.

Step 5 — **demotion ladder.** The winner's final mode is

```
min( mode_request, observer.maxDelivery, policy ceiling, floor/state ceiling )
```

over the ordered ladder `interject > overlay > defer > drop`. Every step can only
move down. There is no path by which an observer, a proposal field, a model
output, or a client request raises a delivery above the user's ceiling — which is
the concrete form of "server output is a proposal, never an executable command".

### 2.4 The in-flight reply rule

Stated as an invariant because the user named it as a current problem:

> A proposal SHALL NOT be delivered as `overlay` or `interject` while an
> assistant reply for the session is in flight. "In flight" means the turn status
> is `committed` or `playback`, or an assistant audio stream is open, or a
> streamed reply has unsent frames.
>
> Such a proposal is demoted to `defer` and surfaces immediately as a bubble. It
> is not queued for later audio; if it still matters after the reply ends, the
> observer will see a new frame and may propose again.
>
> A background task, agent run, queue job, or observer reaching completion SHALL
> NEVER cancel, truncate, or preempt an in-flight reply. Completion notices are
> `defer` deliveries by construction, with no path to `overlay` or `interject`.
>
> The only actor that may take the floor from a speaking assistant is the user,
> through §3.

After a reply reaches a terminal status, audible delivery stays blocked for
`quiet_ms_after_reply` (default 1500 ms) so a proposal does not tread on the tail
of the reply the user is still processing.

### 2.5 User policy

Stored as the `voice_observer_policy` profile field alongside `response_modality`.

```js
{
  version: 1,
  enabled: false,                   // the whole plane, default OFF
  max_delivery: "defer",            // interject | overlay | defer | off — DEFAULT "defer"
  per_observer: {
    "speech-coach": { enabled: true, max_delivery: "defer" },
  },
  quiet_ms_after_reply: 1500,
  min_interval_ms: 8000,            // across all observers, per session
}
```

The user's requirement — "I should be able to configure it so that it just brings
up a text bubble instead of speaking" — is `max_delivery: "defer"`, and that is
the **default**. Observers are silent until the user grants audio, per observer
if they want. `off` disables an observer's delivery entirely while leaving its
receipts, which makes it debuggable without being audible.

`voice_observer_policy` never affects the reply itself; `response_modality`
remains the control for that, and a user who set `response_modality: "text"` also
gets `max_delivery` clamped to `defer` regardless of this field.

## 3. User-Initiated Interruption

The assistant is speaking and the user starts talking. The question is whether
they mean "stop" or are talking alongside.

### 3.1 Signals

Only signals already available during assistant playback are used:

| Signal | Source | Meaning |
| --- | --- | --- |
| explicit stop cue | language-aware stop lexicon (shipped silent-stop path) | unambiguous "stop" |
| sustained speech duration | client VAD `speech_ms` | a backchannel is short |
| content words in the interim transcript | streaming STT interim | "mhm" is not 3 words |
| onset offset relative to assistant utterance boundary | playback progress ledger | speech starting right at a boundary reads as agreement |
| speech continuity | VAD, single burst vs sustained | one burst is a backchannel |

### 3.2 Branches

**`stop_now`** — an explicit stop cue matches. Assistant audio stops immediately,
the cutoff is recorded in the existing interruption ledger via `spoken_progress`,
and **no new turn is created**. This is the shipped silent-stop behaviour,
unchanged; floor classification only short-circuits to it.

**`take_floor`** — sustained speech past `takeFloorMs` (default 700 ms) or at
least 3 content words in the interim, with no stop cue. This is the shipped
barge-in: `planVoiceTurnRelation` closes the active turn as `interrupted` with
`assistant_audio_policy: "stop"` and `provider_tail_policy:
"cancel_and_drop_late_output"`, and admits the new turn as `steering` so it
inherits the partial context. Nothing here is new; the classifier decides *when*
this existing path fires.

**`backchannel`** — a short burst, no stop cue, below both thresholds. The
assistant keeps speaking. The audio is not discarded: it continues to be
transcribed and remains available to the next turn's context. A
`voice_floor_intent` receipt records the call so a wrong one is auditable.

### 3.3 The bias, and why

Cutting the assistant off wrongly destroys something the user wanted to hear.
Being 400 ms late to stop is mildly annoying and fully recoverable. So the
classifier defaults to *keep speaking* and requires evidence to stop — with one
exception, the explicit stop cue, which fires immediately because the user has
said what they mean.

A `backchannel` call is **revisable**. If speech continues and crosses the
`take_floor` threshold within `revisitMs` (default 2000 ms), the plane escalates
to `take_floor` at that moment. A wrong `backchannel` therefore costs latency,
not lost intent. There is no reverse escalation: once the floor is taken it is
not silently given back.

## 4. Partial-Transcript Instability

### 4.1 The stability watermark

`createStreamingSttSession` already keeps `committedText` (provider-finalized
segments, concatenated across rotations) separate from `interim` (the live
hypothesis of the current stream). The watermark is derived from exactly that,
with no new provider signal:

- `stable_text` = `committedText`, further required to be unchanged across the
  last 2 partial emissions. A `committedText` that just changed is not yet
  stable; it becomes stable on the second consecutive emission that leaves it
  untouched.
- `tail_text` = `interim`.
- `watermark = stable_chars / (stable_chars + tail_chars)`, `1` when there is no
  tail, `0` when there is no stable text.

The two-emission requirement matters because a rotation folds the last interim
into `committedText` (`voice-stt-streaming.js`), so freshly committed text can
still be revised by the drained tail of the old stream.

### 4.2 The threshold to act

| Delivery mode | Minimum watermark | Text the proposal may use |
| --- | --- | --- |
| `defer` | 0.0 | `stable_text` or `tail_text` |
| `overlay` | 0.6 | `stable_text` only |
| `interject` | 0.8 | `stable_text` only |

A proposal declares `stable_digest`, the digest of the stable prefix it reasoned
over. If the proposal's text was a function of `tail_text` the observer must not
set `stable_digest`; a proposal without one is capped at `defer`. This is
enforced, not trusted: the arbiter caps any proposal whose `stable_digest` does
not match a prefix the plane actually served.

Revision drift is bounded independently: a proposal is `stale` if the turn's
transcript revision has advanced by more than `maxRevisionDrift` (default 1)
since the proposal's frame. This is the same revision binding `voice-phrase-assist`
already enforces, applied to every observer instead of one.

### 4.3 When the text was later revised

Two cases, distinguished by comparing the proposal's `stable_digest` to the
current stable prefix:

- **Extended** — the current stable prefix starts with the proposal's prefix. The
  user said more; what the proposal reasoned over still stands. Delivery
  proceeds.
- **Revised** — the current stable prefix diverges from the proposal's prefix.
  The proposal reasoned over words the user did not say. It is dropped as
  `revised`.

If a `defer` delivery for that proposal already reached the client, the plane
emits `observer_retract { proposal_id }` and the client removes the bubble.

If an `overlay` or `interject` delivery already played, **nothing can be done**.
Spoken audio is not retractable. That asymmetry is the entire justification for
the higher watermark on audible modes, for `defer` being the default ceiling, and
for the non-Latin restriction below. The design does not pretend to solve it; it
confines it.

### 4.4 Non-Latin scripts, stated plainly

The Ethiopic path has materially higher partial churn than en-US, and the
script-dominance guard in `transcript-quality.js` runs only on the final
transcript — there is no partial-level equivalent. Therefore, when the turn's
input language profile includes a non-Latin script:

- `interject` is unavailable. The ceiling is `overlay`.
- `minStability` for any audible mode is raised to 0.8.
- Any observer whose proposal quotes, corrects, or rewrites the user's own words
  is capped at `defer`.

That last restriction includes the speech coach. On an am-ET turn the coach
produces bubbles only, until per-language partial-stability measurement exists to
justify otherwise. That measurement is named as follow-up work rather than
assumed.

### 4.5 Observer classes that are unsafe on partial input

An observer declares `partialSafe`. It is `false` unless the observer's proposal
is **not a function of the user's exact wording**. Concretely, `partialSafe: false`
is required for anything that quotes the user back, corrects them, asserts what
they said, or would trigger an action. `partialSafe: false` observers may propose
from partials but are capped at `defer`; to be audible they must wait for
`trigger: "final"`.

`partialSafe: true` is for observers whose output does not depend on exact words —
a timer expiring, a calendar boundary, a hard safety cue. Only those may be
audible mid-utterance.

### 4.6 The garbage-transcript guard is not weakened

The observation path is read-only and additive:

- Observations SHALL NOT alter the transcript, commit a turn, write to the
  profile, append canonical conversation history, invoke tools, or launch runs.
- `inspectTranscriptScript` continues to run unchanged on the final transcript on
  the commit path. The observer plane does not run before it, instead of it, or
  in a way that could satisfy it.
- The guard is applied **additionally** as a pre-filter on the observation path:
  a frame whose `stable_text` the guard would reject never reaches an observer,
  and a proposal is dropped as `quality_rejected` at delivery if the guard has
  since rejected the turn's text.
- No observer output is ever a source of profile writes, so the STT-garbage
  profile-write guard has no new surface to defend.

## 5. First Observer: The Speech Coach, End To End

Registration:

```js
plane.register({
  id: "speech-coach", version: 1, priority: 10,
  triggers: ["pause", "final"],
  minStability: 0.7, minIntervalMs: 6000, maxProposalsPerTurn: 3,
  maxLatencyMs: 900, languages: ["*"],
  partialSafe: false,               // it quotes the user's words back
  maxDelivery: "overlay",           // it may never interject
  allowDeferFallback: true,
  observe: coachObserve,
});
```

A turn, step by step:

1. The user speaks. Streaming STT emits partials; the plane builds a frame per
   partial. Watermark is 0.3–0.5 mid-utterance and `trigger` is `partial`, so the
   pre-filter declines every one of them. `coachObserve` does not run. Cost is a
   frame build and seven comparisons.
2. The user pauses 420 ms. The client reports the VAD transition; the plane
   builds a `pause` frame. `stable_text` covers 182 of 201 chars, watermark 0.82.
   All seven pre-filter checks pass.
3. `coachObserve(frame, { signal })` runs with a 900 ms budget. It reads
   `frame.transcript.stable_text` only — never `tail_text` — and calls the same
   no-tool, no-search, short-output adapter that `live-phrase-assist` uses.
4. It returns:
   ```js
   { mode_request: "overlay", text: "try: \"narrow the scope\"",
     speech_text: "try: narrow the scope",
     urgency: 0.3, confidence: 0.7,
     transcript_revision: 42, stable_revision: 41,
     stable_digest: "sha256:…", stability_watermark: 0.82, ttl_ms: 4000,
     reason_code: "phrasing" }
   ```
   If it has nothing worth saying it returns `null`, which costs one counter
   increment and emits nothing.
5. Arbitration window opens. Eligibility passes: not expired, digest matches the
   current stable prefix, revision drift 0, turn still `recording`, guard accepts.
   Score `0.5*0.3 + 0.3*0.7 + 0.2*0.82 = 0.524`. Sole survivor, so it wins.
6. Demotion. `mode_request` is `overlay`; observer ceiling is `overlay`; **user
   policy ceiling is `defer`, the default**; floor state allows `overlay`.
   `min(...) = defer`. Final mode: `defer`.
7. The gateway emits `observer_delivery { proposal_id, observer_id:
   "speech-coach", mode: "defer", text: "try: \"narrow the scope\"",
   requested_mode: "overlay", demoted_by: "user_policy" }`. The client shows a
   bubble. No TTS call is made. The turn is still `recording`; the user has not
   been interrupted, their transcript is unchanged, and their turn commits
   normally.
8. **This is the user's "text bubble instead of speaking" configuration**, and it
   is what happens without the user doing anything.

If the user sets `per_observer["speech-coach"].max_delivery = "overlay"`:

- The same proposal resolves to `overlay`. `speech_text` is synthesized through
  the hosted TTS path at reduced gain and the bubble is shown at the same time.
  Capture is not stopped and the turn is not committed. If hosted TTS fails the
  delivery degrades to `defer` — there is no local-TTS fallback, ever.
- On an am-ET turn it still resolves to `defer` (§4.4), because the coach quotes
  the user's words.
- It can never resolve to `interject`, because its own `maxDelivery` says so.

If a second observer proposes in the same 120 ms window — say a timer at
`urgency: 0.9, confidence: 1.0, watermark 1.0`, score `0.95` — the timer wins the
audio and the coach's proposal is delivered as a bubble via
`allowDeferFallback`. One voice, two bubbles.

## 6. Implementation Slice

Shipped in this change:

- `gateway/lib/voice-observer-plane.js` — registry, validation, frame builder,
  seven-step pre-filter, detached dispatch with timeout, coalescing, strikes, and
  quarantine.
- `gateway/lib/voice-delivery-arbiter.js` — eligibility gate, scoring, total
  order, one-audible-winner rule, demotion ladder, in-flight reply rule, policy
  normalization, floor-intent classification.
- `gateway/lib/voice-stage-diagnostics.js` — extraction from
  `voice-session-server.js`, which is at its source-size ceiling. Wiring the plane
  in has to pay for itself in lines.
- Session wiring at the existing `onTranscriptPartial` / `onTranscriptFinal`
  hooks, next to where `phraseAssist.revisionField` already runs.
- A trivial `word-count` observer used to prove the plumbing without any model
  call, plus unit tests for both new modules.

Deliberately not in this change: the coach's prompt and model adapter, client
presentation of overlay and defer deliveries, client VAD reporting, and
per-language partial-stability measurement.
