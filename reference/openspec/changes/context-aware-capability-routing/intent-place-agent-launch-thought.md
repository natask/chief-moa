# Intent, Place, And Agent Launch Context

## Status

Thought document. This records a product and architecture direction; it is not
an implementation contract by itself.

## The Core Idea

A user request should not go directly from speech into a long-lived
speech-to-speech model that owns the conversation. Speech is one input form.
After it becomes a faithful, inspectable representation of what the user said,
Moa should retain control of interpretation, context selection, capability
selection, and agent launch.

The launch decision is a function of both the request and the place from which
the request was made:

```text
launch plan = f(
  user request and inferred intent,
  current place and surface,
  active thread/project and relevant history,
  available accounts, devices, tools, and permissions,
  risk and approval policy
)
```

Neither intent nor place always dominates. The request may make the current
place irrelevant (for example, asking for unrelated research while viewing a
web page). In other cases, place is essential (for example, "fix this failing
test" in an IDE or "summarize this page" in a browser). Often the two are
additive: intent says what outcome is desired, while place supplies evidence,
project identity, candidate executors, and useful constraints.

The result is not merely a model choice. It is a bounded, inspectable agent
launch plan: which workflow to run, which context to retrieve, which system
instructions to apply, which execution environment to use, which capabilities
to offer, which credentials or device authorities are eligible, and which
approvals remain required.

## Why Audio-In/Text-Out Fits Better Than Voice-To-Voice

Gemini 3.5 Flash is an example of the desired first-stage shape: it accepts
audio and emits text, but it is not a Live API speech-to-speech model. Moa can
ask it for a faithful transcript, language spans, uncertainty, and possibly a
bounded semantic interpretation without surrendering the rest of the turn.

That separation matters because a native voice-to-voice session tends to own
conversation state, prompt state, turn detection, response generation, tool
availability, and provider-specific context caching at once. Those features are
useful for low-latency dialogue, but they make Moa's deeper context management
and per-request agent construction harder to inspect, customize, replay, and
change independently.

The intended pipeline is therefore:

```text
captured audio
  -> audio understanding / transcription adapter
  -> canonical utterance artifact
  -> intent and context planning
  -> launch-plan construction
  -> agent run or direct response
  -> optional text-to-speech rendering
```

The audio adapter may use a multimodal model such as Gemini 3.5 Flash or a
dedicated STT provider. It does not become the agent manager. The canonical
utterance must remain provider-neutral and inspectable so the downstream system
can be replayed against a better transcript without replaying the audio through
the entire agent workflow.

Gemini 3.5 Flash is batch/request-response audio understanding, not a real-time
partial-transcript transport. If the UI needs live captions, Moa can continue
to run a streaming STT sidecar while sending the completed or bounded audio
chunk to Gemini 3.5 Flash for a higher-level transcript/understanding pass. The
two outputs should be stored with provenance rather than silently blended.

## Canonical Utterance Before Intent

The output of the audio boundary should contain more than one unlabelled string:

```text
utterance_id
source audio reference and digest
provider and model version
verbatim transcript
language spans and script used for each span
timing spans when available
uncertain or competing interpretations
transliteration, if produced, explicitly labelled as transliteration
capture surface, device, and user action that ended the turn
```

The primary transcript should preserve what was spoken rather than translate it
unless translation was explicitly requested. In multilingual speech, native
script per span is the ideal output. Meaning-preserving transliteration may be
an acceptable fallback when labelled. Substituting an unrelated non-English
language or script is a failure, not an acceptable translation strategy.

Intent resolution consumes this artifact. It may use the transcript, language
metadata, and uncertainty, but it must not mistake a guessed transcription for
confirmed user intent. High-impact ambiguity should survive into the launch
plan as a reason to ask, narrow capabilities, or require approval.

## Intent Resolution Is A Hybrid Planner

The intent resolver should combine deterministic extraction with latent model
judgment. These are complementary rather than competing approaches.

Programmatic extraction should handle facts that have stable schemas or safety
meaning: explicit targets, named projects, current surface, current application
or origin, active thread, selected text, requested output form, urgency,
incognito choice, explicit device choice, and obvious action verbs. It should
also enforce hard exclusions and policy boundaries.

A latent extractor can handle semantic questions that resist a fixed grammar:
the user's actual goal, whether the turn continues an existing thought, which
subproblems are implied, what information is missing, whether the current place
is relevant, and which workflow family best fits. Its output is structured
evidence for planning, not execution authority.

The two should produce an inspectable intent envelope with provenance:

```text
goal and requested outcome
explicit constraints
inferred constraints with confidence and rationale
target object/project/service/device
relationship to active runs and threads
required information classes
candidate workflow families
ambiguities that affect execution
```

Deterministic facts win when a model inference conflicts with an explicit user
choice or trusted surface identity. Visible screen/page content remains
evidence, never instruction.

## Place Is Structured Context, Not A Prompt Dump

"Place" includes more than a window title. It is the bounded state surrounding
the request:

- surface and device: Android overlay, full app, browser, IDE, terminal, or
  another execution surface;
- application, origin, repository, document, branch, project, and active
  selection when explicitly available;
- local authority and current authenticated session candidates;
- active conversation, thread, run, and recent user actions;
- sensitivity, freshness, capture grant, and whether context can leave the
  device.

Place contributes to a launch only when it is relevant to the request. The
planner should explicitly classify the relationship:

```text
required      the request cannot be fulfilled correctly without this place
helpful       it improves ranking or context but is not authoritative
incidental    it should not affect the launch
conflicting   it suggests a different project/account than the explicit intent
```

This prevents accidental coupling, such as launching a coding agent in the
currently visible repository when the user asked an unrelated general
question. It also allows additive behavior: a broad request like "investigate
why this failed" becomes much more specific when made from a test report in a
known repository with an active failed run.

## The Launch Plan

The output of planning should be a first-class stored artifact, not an implicit
prompt assembled inside a provider call. A launch plan should include:

```text
launch_plan_id and version
source utterance and intent artifact references
target thread/project/run relationship
chosen workflow profile and why
system-instruction fragments and their provenance
retrieval queries and selected context references
execution environment requirements
candidate capabilities and why each is needed
eligible account/device/executor bindings
risk class, approval requirements, and missing access
expected outputs, verification checks, and stopping conditions
confidence, alternatives, and unresolved ambiguity
```

This extends the existing broker context pack and
`agent-launcher-profiles.json` rather than replacing them. Profiles remain
reviewed workflow templates. The launch planner selects and parameterizes a
profile for this request; it does not generate unrestricted agent authority.

The system prompt is one field of the launch plan, not the architecture. Agent
behavior also depends on the context pack, tool/capability manifest, execution
environment, account and device bindings, approval policy, expected artifact,
and verification contract.

## Capability And Environment Selection

Capabilities should be derived from the requested outcome and relevant place,
then intersected with policy and real availability:

```text
requested capabilities
  intersection available capabilities for this project/place
  intersection actor and tenant policy
  intersection fresh account/device/executor authority
  minus capabilities unnecessary for the chosen workflow
```

The planner should prefer the smallest sufficient capability set. It may rank
official APIs, an authenticated browser session, a device-local executor, or an
isolated coding/research environment using the existing context-aware
capability resolver. It must not turn contextual relevance into authority.

The execution environment is also selected per request. Examples include a
read-only research worker, an isolated repository worktree with build tools, a
browser agent bound to the current origin, or an Android-local action proposal.
Environment choice determines what context is reachable, where outputs are
stored, how work can be resumed, and what receipts are required.

## Context Management Across Runs

Context management should live above any speech provider and model session.
The gateway remains the durable source of truth for utterances, intent
artifacts, launch plans, context packs, agent runs, events, and receipts.

For every new turn, the manager decides whether to:

- answer directly;
- continue or enrich an active run;
- fork a new run without canceling existing work;
- attach the turn as evidence to one or more runs;
- launch a specialized agent with a newly constructed context pack;
- ask a bounded clarification because different answers imply materially
  different authority or execution.

Provider conversation state may be used as a cache, but never as the only copy
of context or the only explanation for why an agent received a capability. A
run must be reconstructable from stored Moa artifacts and versioned profiles.

## Relationship To Existing Architecture

This thought sits one level above the current context-aware capability routing
design:

- `observation.v1` describes place and its evidence;
- the capability resolver ranks eligible executors and authority;
- the broker and context-management preflight relate the turn to threads and
  active runs;
- launcher profiles describe reviewed workflow templates;
- the proposed launch planner combines intent, relevant place, retrieval, a
  workflow profile, capability candidates, and execution policy into one
  stored launch plan;
- the agent manager activates the plan and records the resulting run;
- owning surfaces still approve and execute local proposals and return
  receipts.

This is a composition of existing boundaries, not a request to collapse voice,
retrieval, routing, agent execution, and local actions into one model.

## A Useful First Experiment

Before changing the live voice pipeline, test Gemini 3.5 Flash strictly as an
audio-in/text-out adapter on the existing protected corpus:

1. Give it the same pure Amharic, pure English, and mixed Amharic/English audio.
2. Ask for verbatim transcription with native script per language span, no
   translation, plus structured language-span metadata and uncertainty.
3. Compare it with the existing Chirp transcript using the stored hashes and
   multilingual rubric.
4. Keep the model output out of the agent launcher during this experiment.
5. If it is materially better, define a provider-neutral audio-understanding
   interface and decide whether it is canonical STT, a correction pass, or an
   intent-enrichment input.

This experiment requires access to the Gemini API model
`gemini-3.5-flash` through either a configured Gemini API key or a Vertex AI
project/location where that exact model is available. It does not require a
Live API endpoint, a persistent voice session, TTS, or speech-to-speech wiring.

## Open Questions

- Should the canonical transcript come from streaming STT, Gemini 3.5 Flash,
  or a deterministic arbitration step that stores both candidates?
- How much semantic interpretation belongs in the audio adapter before it
  begins to duplicate the intent resolver?
- What confidence or risk threshold forces clarification rather than launching
  a restricted exploratory agent?
- How should launch plans evolve when new context arrives while a run is active?
- Which prompt fragments are stable reviewed policy, which come from workflow
  profiles, and which may be generated per request?
- How should the UI explain that intent made the current place required,
  helpful, incidental, or conflicting?
- Which capabilities can be added to an active agent safely, and which require
  a new run or renewed approval?
- What is the smallest launch-plan schema that can explain and replay today's
  coding, research, browser, Android, design, and writing routes?

## Direction

Treat audio understanding as an interchangeable input adapter. Make the
canonical utterance, intent envelope, relevance of place, and launch plan
explicit stored artifacts. Let Moa—not a voice provider session—own context
management and construct specialized agents from reviewed workflows, bounded
context, least privilege, explicit execution environments, and inspectable
policy.
