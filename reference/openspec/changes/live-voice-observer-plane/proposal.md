# Live Voice Observer Plane

## Why

Today exactly one thing reasons about a voice turn, and it runs once, after the
user stops speaking. Everything else that could usefully react while the user is
still talking — a phrasing coach, a timer, a safety cue — has nowhere to attach.
The only shipped in-speech aid, `live-phrase-assist`, is a hard-wired,
client-pulled, never-audible special case: it cannot speak, cannot be joined by a
second aid, and every new aid would have to repeat its cooldown, revision, and
staleness logic.

The user wants a plug-in point instead: applications that observe speech as it
arrives and, when they have something worth saying, get to say it — sometimes
alongside the user without stopping them, sometimes taking the floor, and
sometimes only as a bubble. That last case is a setting the user asked for by
name.

Two failure modes make this a real design problem rather than a callback list:

1. **Partial transcripts are wrong on purpose.** An observer that acts on
   half-heard speech will act on words the user did not say. This is worse in
   am-ET, where the stable prefix churns more.
2. **Speech is a shared floor.** Something that speaks at the wrong moment is
   worse than something that stays silent. A background task finishing must not
   step on a reply that is already playing, and the assistant must be able to
   tell "stop talking" from "mhm, go on".

## What Changes

- Add a **voice observer plane**: a registration point where a plug-in receives
  read-only frames of the in-progress turn and returns a proposal or declines.
  Pre-filtering happens in the plane, so a declining observer usually costs
  nothing because its code never runs.
- Make observation **structurally incapable of blocking the turn**. Observers run
  off the turn path, under a latency budget, with coalescing, timeouts, and
  per-turn quarantine on repeated failure. The commit path never awaits one.
- Add a **delivery arbiter**: the single place that turns proposals into
  delivery. Observers propose a mode; the arbiter decides, and may only move the
  proposal *down* a fixed ladder `interject -> overlay -> defer -> drop`. No
  observer can escalate itself past user policy.
- Define the three delivery modes precisely: `overlay` (audible beside the user,
  does not stop them), `interject` (takes the floor, the user is expected to
  stop), `defer` (bubble or notification, never audio).
- Add a user policy `voice_observer_policy`, default-off, whose default delivery
  ceiling is `defer` — the user's "text bubble instead of speaking" is the
  default, and audio is opt-in.
- State the **in-flight reply rule** as a hard invariant: no observer, background
  task, agent run, or queue job may cancel, truncate, or preempt an assistant
  reply that is already in flight. Only the user takes the floor from the
  assistant.
- Add a **floor-intent classification** on top of the existing barge-in and
  interruption-cutoff ledger, distinguishing an explicit stop cue, a real
  take-the-floor, and a backchannel — biased toward letting the assistant finish,
  and escalating late rather than cutting early.
- Define a **stability watermark** over the streaming transcript, split
  `stable_text` from `tail_text`, and forbid audible delivery of a proposal that
  was computed from unstable text or whose stable prefix was later revised.
- Ship the **speech coach** as the first observer, and prove the plumbing in the
  gateway with the registration point, the arbiter, and one trivial observer.

## Relationship To What Already Shipped

This change builds on shipped behaviour and does not re-implement it.

- **Streaming STT** (`voice-stt-streaming.js`) already separates finalized
  segments from the live interim. The stability watermark is derived from that
  existing split, not from a new signal.
- **Live phrase assist** (`voice-phrase-assist.js`) already binds work to a
  transcript revision and suppresses stale, unchanged, and repeated requests. The
  observer plane generalizes that discipline; phrase assist becomes the first
  observer's generation adapter rather than a parallel mechanism.
- **Barge-in and the interruption cutoff ledger** (`voice-turn-steering.js`,
  `planVoiceTurnRelation`, `spoken_progress`) already stop assistant audio, close
  the superseded turn as `interrupted`, and record where speech was cut. Floor
  classification decides *whether* to trigger that path; it does not replace it.
- **The transcript quality guard** (`transcript-quality.js`) is untouched and is
  additionally applied as a filter on the observation path.
- **`response_modality`** already distinguishes text from speech for replies.
  `voice_observer_policy` is the analogous control for observer output and never
  overrides `response_modality` for the reply itself.

## Scope

This change specifies the whole contract and implements the gateway slice: the
observer registry, the frame builder and pre-filter, the dispatcher with its
latency and failure handling, the arbiter with all four outcomes and the policy
ladder, and one trivial observer with tests.

Out of scope here: the coach's language-model prompt work, Android and browser
presentation of overlay/defer deliveries, client-side VAD reporting, and the
per-language partial-stability measurement that would let a non-Latin script
graduate from the `defer` restriction. Each is named as follow-up work.
