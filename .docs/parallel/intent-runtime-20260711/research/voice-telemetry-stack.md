# Voice-agent telemetry stack: validated boundary and reuse map

Checked against current official documentation on 2026-07-11. “Not provided”
below means it is not claimed in the inspected official product documentation;
it is not a universal claim that no private or newer implementation exists.

## Precise category model

The user's category correction is right. A production voice system has at least
three different data authorities:

1. **Voice transaction history** — admitted input audio, transcript, model/tool
   exchange, output audio, intent/action/receipt, consent, and retention. This is
   canonical product data, not disposable observability.
2. **Pipeline telemetry** — spans, timings, counters, errors, resource use, and
   release correlation for capture/VAD/transport/STT/LLM/tools/TTS/playback.
   This is derived, bounded, and safe to lose or rebuild.
3. **Evaluation/operations knowledge** — human/agent annotations, incident
   groups, learned failure signatures, regression corpora, priorities, and daily
   briefs. These are versioned conclusions grounded in the first two layers.

OpenTelemetry is a useful transport and vocabulary for layer 2. It is not the
database schema or retention authority for layers 1 or 3.

## Closest current products/frameworks

### LiveKit Agents

Official docs:

- <https://docs.livekit.io/deploy/observability/insights/>
- <https://docs.livekit.io/deploy/observability/data/>
- <https://docs.livekit.io/deploy/observability/tracing/>

It is the closest complete reference outcome: a synchronized session timeline
with user/agent audio, transcripts, logs, STT/LLM/TTS/tool traces, and latency
metrics. Its SDK also exposes local session reports/data hooks and exports OTel
traces to Langfuse or another OTLP backend.

Constraint: the unified Insights product is LiveKit Cloud, has a documented
30-day window, and does not operate for entirely self-hosted media deployments.
Therefore it validates the product UX and event model, but does not by itself
satisfy Chief Moa's owned-data/self-hosted requirement.

### Pipecat

Official docs:

- <https://docs.pipecat.ai/api-reference/server/utilities/opentelemetry>
- <https://docs.pipecat.ai/pipecat/fundamentals/metrics>

Pipecat is the strongest inspected open-source instrumentation reference for a
voice pipeline. It emits OTel turn/service spans, latency/TTFB/processing/text-
aggregation measures, LLM token usage, TTS character usage, turn tracking, and
can export to Jaeger, Grafana, Langfuse, or other OTLP destinations.

Constraint: it is a pipeline framework and instrumentation source, not an
owned, unified audio/transcript/trace database and product UI. Adopting its
metric names or observer patterns is useful; replacing Chief Moa's provider
pipeline to obtain them is not justified.

### Langfuse

Official docs/repo:

- <https://langfuse.com/docs>
- <https://github.com/langfuse/langfuse>

Langfuse remains a mature open-source/self-hostable LLM trace, session, eval,
prompt, dataset, and annotation backend, now explicitly OTel-based. LiveKit and
Pipecat both document exporting their traces to it.

Constraint: its primary artifact is an AI/LLM trace. It can hold metadata and
links, but the inspected docs do not provide the voice-native synchronized
audio waveform/playback, capture/transport QoE model, or authoritative audio
retention lifecycle required here. Use it as an optional trace/eval projection,
not the voice transaction database.

### Arize Phoenix / OpenInference

Official docs:

- <https://arize.com/docs/phoenix>
- <https://arize.com/docs/phoenix/tracing/how-to-tracing/advanced/masking-span-attributes>

Phoenix is another credible self-hostable OTel/OpenInference trace/eval
backend, with session/trace analysis, annotations, experiments, and explicit
masking. Its current Phoenix server is Elastic License 2.0, so it is
source-available rather than OSI open source. It has the same boundary for this
use: good optional projection/eval plane; not the inspected all-in-one voice
audio transaction product and not an open-core dependency to adopt casually.

## Validated conclusion

The idea is valid, but the wedge should be stated narrowly:

> An owned, low-latency voice transaction and reliability layer that joins exact
> input/output audio with STT/LLM/tool/TTS/playback traces, release/code/intent
> correlation, tail-latency/failure analysis, and agent-produced next actions.

Among the inspected mature/open options, no one package delivers that complete
self-hosted outcome out of the box. The lowest-risk assembly is:

```text
Chief Moa canonical voice + intent store
  -> bounded domain diagnostics and source receipts
  -> OTel-compatible trace projection
  -> optional Langfuse or Phoenix backend
  -> agent incident/daily-brief projection
```

LiveKit supplies the best product-reference timeline; Pipecat supplies the best
framework-level metric/tracing reference; Langfuse/Phoenix supply reusable
trace/eval backends. Chief Moa should build only the missing canonical voice
transaction, correlation, privacy, and agent-closing-the-loop semantics.

## Minimum useful owned schema

- Session/turn/draft/intent IDs; tenant, surface, release, deployment, provider,
  model, and exact authority receipts.
- Content-addressed input/output audio refs plus encoding/rate/channels,
  duration, consent, retention/deletion state, and transcript provenance.
- Ordered stage spans: queue, capture, transport, VAD/endpoint, STT, reasoning,
  each model/tool round, TTS, first/last playback, completion/interruption.
- Derived measures: time to first transcript/token/audio, user-to-bot latency,
  stage duration, gaps, real-time factor, byte/frame counts, retries, cost/usage,
  and p50/p95/p99 projections by bounded dimensions.
- Failure evidence: stage, stable class, bounded summary, retryability, code and
  deployment refs, regression signature, owner/priority, linked repair/result.
- Privacy: raw audio/text never metric labels or external spans; deletion
  propagates to content, transcript, eval corpora, exports, and cached briefs.

## First valuable agent output

A daily brief, not another dashboard:

- what newly failed and what is recurring;
- affected intents/users/releases and severity/confidence;
- the slowest/tail-regressed voice turns with the exact failing stage;
- likely code/deployment correlation, clearly labeled as inference;
- one recommended next action or tested repair proposal;
- links back to owned evidence, never an ungrounded summary.
