# Persistent Voice Modes And Development Routing (2026-07-14)

## Status

The Ask/Note/Coach gateway mode-state slice was authorized on 2026-07-15 as
internal routing state. Visible client mode selectors are rejected. Capture
blocks, Dictate, Development routing, video routing, worker changes, and
deployment remain proposed and are not authorized by this slice.

## Linearized Intent

1. The lion/orb should be a dependable, low-friction microphone control. Tap to
   start, tap again to stop, with press-and-hold available as an eyes-free
   push-to-talk accelerator.
2. What happens after stop should come from one persistent conversational
   intent, not from a visible selector or a growing vocabulary of hidden
   gestures.
3. The user changes that intent conversationally. The orb may show a compact
   status while active, but it is not a mode picker.
4. In an Ask mode, stopping sends the transcript as the message rather than
   merely filling an intermediate text box.
5. In a Dictate mode, Moa should replace Wispr Flow by inserting selected text
   into the currently focused field without submitting it.
6. In a Note mode, stopping creates a durable recording and literal transcript
   without an assistant reply or agent launch.
7. In a Development mode, stopping creates a durable project intent and routes
   explicitly authorized work to a coding execution environment, with visible
   run, diff, verification, commit, and deployment state.
8. Development work should remain available when the user's laptop is offline;
   the VPS should therefore host or reach a persistent execution environment
   containing the user's projects.

## Current Runtime Status

Evidence inspected on 2026-07-14:

- Android builds default to `https://api.agee.app`, and the app has editable
  gateway URL/token settings.
- The production gateway is healthy in `self-host` mode. Its active voice path
  is configured for Chirp 3 STT, gateway reasoning, and hosted Gemini TTS for
  `en-US` and `am-ET`.
- The production gateway has worker-pull enabled and one registered worker
  record, but its own container exposes only the harmless `echo` harness;
  Codex, Claude, Gemini, and Hermes commands are unavailable there.
- No worker runtime process is currently running on this development Mac.
- A separate local gateway is running at `10.147.17.6:8787`; it can see Codex,
  Claude, and Gemini and uses `/Users/natnaelkahssay/projs` as its harness work
  directory. The production Android default does not point at that local
  gateway.
- Android already supports voice chat, async agent-run creation and status,
  raw audio-note record mode, and an experimental voice-first orb gesture flag.
- Android is not an `InputMethodService`, so it cannot yet provide reliable
  system-wide dictation through `InputConnection`.
- The proposed `capture_block`, notebook, IME, and in-app modification request
  changes remain unimplemented and explicitly await alignment.

The practical result is that the phone is connected to production voice but is
not currently connected to an execution worker that can edit Chief Moa.

## Product Decision

Separate **capture mechanics** from **delivery mode**.

Capture mechanics stay stable in every mode:

- tap starts recording;
- a second tap stops and applies the current mode's delivery behavior;
- still press-and-hold is push-to-talk and applies the same delivery behavior on
  release;
- drag moves the orb;
- triple-click cancels an active capture without sending; a large movement
  after hold capture starts also cancels and escapes into drag.

Do not use swipe direction, multi-click count, or a visible control as a mode
selector. Multi-clicks own interruption and branch mechanics. Behavioral intent
is expressed conversationally.

The admitted policy is device-scoped and persistent. The user changes it by
voice (for example, “take a note” or “coach me on this”). The orb may report the
active behavior as status, but offers no selector. A spoken policy change is a
control turn and does not leak into the next note, dictated field, message, or
development instruction.

## Mode Contract

The first gateway slice uses this explicit truth table. Mode selection is
versioned and device-scoped. Coach is a bounded turn-local instruction layered
over the saved persona; it never rewrites that persona, and selecting Ask
removes the overlay on the next turn.

| Mode | Storage | Provider/model work | Assistant reply | Agent dispatch |
| --- | --- | --- | --- | --- |
| Ask | Normal conversation-turn policy | Allowed through normal routing | Normal response policy | Existing explicit routing only; mode itself launches nothing |
| Note | Raw audio through `/v1/audio-notes` | Forbidden | None | Forbidden |
| Coach | Normal conversation-turn policy | Allowed with bounded coaching overlay | Concise coaching response | Existing explicit routing only; mode itself launches nothing |

Clients SHALL read mode admission before opening a provider-backed voice path.
A Note admission redirects capture to `/v1/audio-notes`; submitting a transcript
to the conversational turn route while Note is selected also fails closed with
a storage-only routing decision. Transcript/notebook processing is a later
capture-block slice.

The broader proposed mode map remains:

| Mode | Stop/release behavior | Canonical result | Must not do |
| --- | --- | --- | --- |
| Ask | Send the finalized transcript as a conversational turn | Stored turn and response | Merely insert into a draft field |
| Dictate | Preview/clean if configured, then locally insert selected text | Capture block plus insertion receipt | Submit, click Send, or launch work |
| Note | Store audio first, then produce a literal transcript | Capture block in notebook | Reply conversationally or launch work |
| Development | File a project-bound modification/work intent; launch only under the selected authority policy | Intent, run IDs, evidence, and lifecycle | Infer repo or authority from screen text |

“Export” is better modeled as a post-capture action over a note or selected
revision, not as a permanent capture mode, unless a specific destination and
automatic delivery policy are later defined.

## Development Execution Shapes

### A. Laptop worker connected outbound to the production gateway

This uses the existing worker-pull boundary. It is the smallest route to phone
initiated code changes and keeps repositories and developer credentials on the
current machine. It works only while the laptop and worker service are online.

### B. Put coding harnesses inside the production gateway container

This is mechanically direct but rejected. It gives a public, stateful gateway
container project write access and developer credentials, couples voice/API
availability to arbitrary builds, and lets a runaway build compete with the
production database and live voice turns.

### C. Add a persistent VPS execution worker (selected always-on shape)

Run an outbound worker as a separate unprivileged service, container, or host
with its own project volume, workspace isolation, harness credentials, resource
limits, and run leases. It connects to the gateway through the existing scoped
worker-pull contract. The gateway remains the router and record owner; the
worker owns repository checkout, edits, tests, commits, and release commands.

For the current small production droplet, prefer a separate worker droplet or
equivalent execution host. A same-host worker is acceptable only as a personal
alpha step if it has a separate Unix identity/container, no gateway database or
provider-secret mounts, strict CPU/memory/disk limits, per-run worktrees, and an
emergency stop that cannot take down the gateway.

## Why The Always-On Execution Goal Makes Sense

The motivation is sound: phone-initiated development is only useful if work can
continue after the phone interaction and without depending on an awake laptop.
A durable remote project workspace also makes status, diffs, verification, and
follow-up turns consistent across devices.

The adjustment is to make the VPS an **execution environment adjacent to the
gateway**, not to make the gateway process itself a shell. This preserves the
existing trust boundary and lets the execution capacity move, scale, restart,
or be revoked independently of voice and conversation storage.

## Development Mode Flow

```text
tap -> speak -> tap
  -> Android durably accepts the capture and shows a local receipt
  -> gateway stores literal transcript + project candidates
  -> explicit binding selects chief-moa (screen text is evidence only)
  -> selected authority policy decides plan-only vs implementation
  -> gateway queues a scoped run and immediately returns its run id
  -> persistent worker claims it in an isolated project worktree
  -> worker reads repo instructions, edits, verifies, commits, and creates
     preview/release evidence under the existing promotion gate
  -> Android shows running / input-needed / verified / committed / deployed or
     blocked state
```

Development mode should retain two visible authority policies:

- `Plan`: architecture and ticket artifacts only; never edits source.
- `Implement`: bounded implementation is authorized for the explicitly bound
  project, still subject to repository instructions and deployment gates.

The mode may persist, but project identity and implementation authority must be
visible. A transcript, screenshot, accessibility snapshot, or model guess cannot
silently change either one.

## Smallest Coherent Delivery Order

1. Align the four-mode contract and the persistent mode behavior.
2. Reconnect the existing development Mac as an outbound worker and prove one
   harmless phone -> VPS -> worker -> visible-result run. This validates routing
   before provisioning permanent compute.
3. Complete durable capture blocks and the Android notebook so speech cannot be
   lost while downstream work fails.
4. Ship Ask and Note as the first persistent modes using existing surfaces.
5. Add the Android IME and Dictate mode with sensitive-field refusal and
   `InputConnection` insertion.
6. Add deterministic Chief Moa project binding plus Plan/Implement authority in
   Development mode.
7. Provision a separate persistent execution worker, mirror/clone selected
   projects, prove backup/restore and worktree isolation, then move development
   runs from the laptop worker to it.

## Alignment Decisions Needed

1. Accept Ask, Dictate, Note, and Development as the four initial persistent
   modes, with Export as a post-capture action.
2. Accept tap/tap and hold/release as equivalent capture controls whose outcome
   is determined by the current mode.
3. Choose whether Development mode defaults to `Plan` (recommended) or remembers
   the last Plan/Implement authority setting.
4. Accept a separate persistent execution worker as the always-on target, using
   the laptop worker first as the end-to-end proof.
