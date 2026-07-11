# Design: Open voice reliability control plane

## Product definition

Test an open endpoint-to-gateway voice reliability recorder for browser-based
realtime voice products.

The economic buyer and primary operator are initially the same person: a
voice-infrastructure lead who owns the browser endpoint, gateway, and incident
response. The repeated incident is dead air or late playback even though the
server reports that it emitted audio.

The MVP supports only the Chief Moa browser client and Node gateway, uses local
storage, and renders one synchronized timeline. It must answer:

- When did the server emit audio?
- When did the endpoint receive, queue, and begin presenting it?
- What network, route, buffer, and clock uncertainty remains?
- Does that evidence change the server-only diagnosis?

Physical hearing cannot be proved without acoustic loopback. The MVP calls the
measurement `endpoint_observed_playout`, not "actual hearing," and presents it
as a proxy with uncertainty.

The longer-term product loop, gated by demand and MVP evidence, is:

```text
voice runtime + client QoE + release metadata
                    |
                    v
       bounded asynchronous recorder
                    |
          +---------+----------+
          |                    |
          v                    v
 synchronized replay     cohort/tail queries
          |                    |
          +---------+----------+
                    v
           failed-call fixture
                    v
 read-only diagnosis -> isolated candidate -> fixed-corpus comparison
                    v
 evidence-backed PR -> human approval -> canary -> measure or rollback
```

## Product boundary

The shared primitive with StarSling is the closed loop:

```text
evidence -> diagnosis -> candidate -> experiment -> review -> rollout -> measure
```

The products remain separate. Generic CI optimization changes runners, caches,
test shards, and workflow DAGs for a DevOps buyer. Voice reliability changes
VAD/endpointing, prompt/config, provider/model routing, TTS chunking, playback,
and tool behavior for a voice-product buyer. The voice product integrates with
CI by publishing voice regression checks; it does not need to own CI runners.

## Semantic model

The MVP drafts only session, turn, server-audio-write, endpoint-audio-receipt,
endpoint-observed-playout, transport, clock-calibration, and release records.
It does not freeze a public standard.

A later portable model may use stable opaque identifiers and versioned records:

- `voice.session`: conversation, surface, region, release, consent, retention;
- `voice.turn`: one user/assistant exchange and its terminal outcome;
- `voice.segment`: user or assistant audio interval and speaker/channel;
- `voice.stage`: an observed stage or native-audio activity interval;
- `voice.transport`: WebRTC/WebSocket/SIP delivery and network observations;
- `voice.playback`: client receipt, queue, playout, stop, and underrun evidence;
- `voice.tool`: proposal, approval, execution, and receipt;
- `voice.artifact`: encrypted audio/transcript/config/replay references;
- `voice.outcome`: deterministic task result, human label, or versioned judge;
- `voice.release`: git SHA plus application, prompt, profile, model, provider,
  evaluator, and schema versions.

IDs used for correlation are never metric dimensions. User identity, raw audio,
transcripts, prompts, file/page content, and credentials are not telemetry
attributes. Wall-clock time supports navigation; monotonic process-local time
measures durations. Cross-device subtraction requires clock-offset and
uncertainty evidence rather than assuming clocks are synchronized.

### Evidence provenance and ingestion authority

Every observation records its source and trust level: client-observed,
gateway-observed, provider-reported, operator-labeled, deterministic outcome, or
versioned-evaluator result. A client cannot assert server-owned release,
tenant, policy, or evaluator authority.

Hosted ingestion requires tenant/project-bound credentials, schema and size
validation, rate limits, idempotency/replay protection, and server-assigned
authority fields. Unknown, duplicate, stale, or cross-tenant records are
rejected or quarantined so a compromised client cannot poison cohorts.
Browser clients receive only short-lived, write-only tickets bound to tenant,
project, session, allowed origin, schema, and a nonce. Tickets are revocable and
have no query, export, replay, or administrative authority; long-lived project
keys never ship to a browser.

### Cascaded and native-audio honesty

A cascaded pipeline may expose capture, VAD/end-of-utterance, STT, context,
reasoning, tools, TTS, transport, playback, and storage stages.

A native speech-to-speech provider may expose only input audio activity,
provider events, tool activity, output audio chunks, transport, and playback.
The system must not fabricate STT/LLM/TTS spans when the provider does not expose
those boundaries. Optional shadow transcription is labeled as a separate
observation, never as provider ground truth.

## Timing and quality contract

Raw milestones include:

- capture armed, user speech start/end, capture commit;
- gateway ingress and provider admission;
- endpoint/VAD commit;
- STT first partial/final;
- reasoning first token/done and tool proposal/receipt;
- TTS first byte/segment/done;
- server first audio write;
- client audio receipt, queue, endpoint-observed playout start/end;
- interruption requested, provider canceled, playback stopped;
- turn stored and outcome recorded.

Derived measures include:

- end-of-utterance delay;
- STT final latency;
- reasoning time to first token;
- TTS time to first byte;
- server time to first audio;
- endpoint-observed time to first audio, with route/clock uncertainty;
- dead-air duration;
- barge-in stop latency and unwanted overlap;
- complete-turn latency;
- offered, admitted, completed, rejected, timed-out, and dropped turns per
  window;
- active sessions/turns, provider concurrency, admission/queue delay,
  saturation, rate-limit, and backpressure state;
- packet loss, jitter, concealment, underruns, and playout delay;
- task success, tool correctness, interruption failure, error rate, and cost.

Every percentile query reports its time window, sample count, filters, and
schema/evaluator versions. Its versioned query policy also defines the target
population, inclusion/exclusion rules, minimum sample count, estimator,
confidence/error method, and handling of missing, censored, rejected, dropped,
and clock-uncertain observations. The response emits that policy and the counts
for each class. A p99 without this evidence is not a product claim.

## Collection and storage

Instrumentation records timestamps and small bounded events synchronously, then
exports asynchronously through a bounded queue or local spool. Export failure,
queue overflow, media upload failure, or an unavailable backend cannot delay or
fail the voice turn. Judges, transcription copies, waveform generation, and
audio upload never run in the realtime path.

Before implementation, a profile must set maximum event bytes/rate, in-memory
queue length, disk-spool bytes/age, exporter concurrency and timeout, and
resource/latency budgets. Enqueue never waits on network or disk. Overflow uses
a deterministic priority that preserves terminal error/drop counters while
dropping lower-priority detail; disk-full degrades to metadata counters without
blocking voice. Saturation and concurrent replay/query fault tests must prove
the approved p50/p99 voice-latency, jitter, CPU, memory, and I/O budgets. No
numeric production claim exists until those measurements run.

Recommended modes:

- **Local/self-hosted starter:** one process, SQLite metadata, local encrypted
  files, and a compact query/replay UI. This preserves the Emdash-style easy
  adoption path.
- **Hosted/scale:** Postgres for tenants, projects, policy, consent, and control
  state; a columnar store such as ClickHouse for high-volume events and cohort
  queries; S3-compatible object storage for encrypted audio and replay assets.
  A queue or stream is added only when measured ingestion requires it.

The authenticated ingestion boundary should accept the product's versioned envelope
and an OpenTelemetry translation. The product owns voice semantics; OTLP remains
a portability protocol rather than the product database.

## Replay and evaluation

A replay fixture is a versioned, consented derivative of a production or
synthetic interaction. It records artifact hashes, allowed media, transcript,
turn boundaries, profile/prompt/provider versions, network conditions when
available, expected deterministic outcomes, evaluator versions, and deletion
lineage.

Development fixtures may expose expectations for debugging. Improvement claims
also require a coordinator-owned sealed holdout whose inputs are accessible only
through the runner and whose labels remain hidden from the candidate. Every
candidate, including failed or abandoned attempts, is appended to an immutable
trial ledger; the coordinator applies the versioned repeated-trial/multiple-
hypothesis correction before accepting a claimed improvement.

Replays distinguish three modes:

1. deterministic component replay for parsers, routing, tools, and storage;
2. provider replay, which is measured but may be nondeterministic and costly;
3. end-to-end client replay, which measures delivery and endpoint-observed
   playout.

Production data does not silently become a test dataset. Redaction, purpose,
retention, deletion propagation, and access policy must pass before fixture
creation.

## Improvement-agent trust contract

The first agent is read-only. It ranks failing cohorts, explains evidence,
names uncertainty, and proposes one bounded experiment.

An implementation agent may later create a candidate only when all of these
hold:

- it works in an isolated branch/worktree or preview;
- the allowed files and parameter surface are explicit;
- an independent coordinator signs a hashed benchmark manifest before the
  candidate runs;
- baseline and candidate use paired sample IDs, the same corpus, collection and
  aggregation code, evaluator versions, and minimum sample/confidence policy;
- a sealed holdout with hidden labels and the immutable all-candidate trial
  ledger controls the final improvement claim and repeated-trial correction;
- every scheduled, failed, timed-out, dropped, and censored attempt stays in the
  denominator;
- the candidate cannot self-approve, merge, deploy, or change the evaluation
  corpus;
- the report includes failures and regressions, not only wins;
- rollback is a config, artifact, or Git ref that has been proved usable.

The candidate runs in a capability-enforced sandbox with exact path and
parameter allowlists, no production credentials or production write API, and a
network-egress allowlist. Corpus, evaluator, policy, aggregation, telemetry,
workflow, and deployment files are mounted read-only. A separate branch-only
principal may open a pull request but cannot merge it or modify an existing or
default branch. Audio, transcripts, provider payloads, and screen/page content
are untrusted data, never agent instruction.

### No-gaming objective

Voice optimization is multi-objective. A candidate cannot claim lower latency
by truncating answers, dropping difficult calls, reducing sample retention,
weakening safety/tool checks, lowering audio quality, ignoring interruptions,
changing status labels or denominators, suppressing telemetry, relabeling
timeouts, or changing the judge. Candidate comparison reports a Pareto set across at
least latency, task/response quality, cost, interruption/error rate, and safety.
Thresholds are product/profile policy, not agent-authored values.

Human approval remains required until a separately approved policy defines a
bounded low-risk auto-rollout class. Initial production rollout is canary-only
with automatic stop/rollback on invariant or budget regression.

## Privacy, security, and trust

Voice is sensitive content, not ordinary telemetry.

- Data classes are explicit: bounded operational metadata, redacted/derived
  content, and raw content artifacts. Metadata-only mode is the default.
- Raw audio/transcript retention is off unless purpose, participant/tenant
  policy, and a retention class authorize an encrypted raw-artifact exception.
  The raw value stays behind an opaque artifact reference and remains out of
  logs, spans, metric dimensions, and agent prompts.
- Separate participant tracks are preferred when consent and transport allow;
  access is audited.
- Tenant isolation, RBAC, deletion propagation, export, residency, and
  bring-your-own-bucket/object-store controls are product requirements.
- Error strings and provider payloads pass allowlist/redaction before export.
- Evaluators are versioned and calibrated against human labels; an LLM score is
  evidence, not truth.

Sensitive metadata and derived content are allowlisted/redacted before
persistence. Raw artifacts follow the encrypted exception above. Content and
keys use tenant-scoped encryption, and RBAC plus audit covers every read/export.
Deletion propagates through managed source artifacts, derivatives, fixtures,
indexes, caches, exports, and backup-expiry/tombstone processing. For an export
already delivered outside the managed boundary, the system revokes managed
links and emits a signed tombstone/deletion notice; it does not falsely claim it
can erase a recipient-controlled copy. A restore drill must prove deleted
managed content cannot silently reappear.

## Preview and rollout safety

Any deployable candidate uses a separate preview URL, database, queue, object
prefix/bucket, and worker pool. Promotion requires verified backup and restore,
backward-compatible schemas, session-sticky releases, and proof that active
turns, uploads, replay jobs, and evaluations can drain, resume, or retry without
being stranded. Canary monitoring is independent of the candidate, stops or
rolls back on invariant/budget regression, and is followed by a promoted-target
smoke check.

## Open-source and company boundary

Trust requires a clear license, portable data, and no fake "open source" label.
The recommended starting contract is Apache-2.0 for the semantic conventions,
SDKs, collector, local server, replay format, and core UI. Hosted value comes
from managed ingestion, retention, scaling, team access, enterprise identity,
private networking, support, and expensive evaluation/optimization compute.

If licensing changes later, the project must plainly distinguish open source
from source-available code. All users retain documented export and self-hosted
restore paths.

Before making an open-source product claim, the release includes a component
and license matrix, SPDX-marked license files, a dependency/codec/model license
inventory, no mandatory hosted dependency or phone-home for core operation, and
a full-fidelity hosted-export-to-self-hosted-restore test.
Every component marketed as open source uses an OSI-approved license.
Proprietary and source-available components are labeled separately and never
counted as open-source coverage.

## Pull-request check authority

Voice regression CI runs on `pull_request`, not elevated
`pull_request_target`; receives no secrets, OIDC token, production network, or
deployment credentials; declares read-only repository permissions; and pins
third-party actions to reviewed commit SHAs. If a check result must be written,
a separate trusted reporting job consumes only a sanitized artifact and holds
the narrow check-write permission. Untrusted candidate code never runs in that
reporting principal.

## Chief Moa dogfood path

Chief Moa already proves gateway-side stage evidence and failure diagnosis. The
gated sequence is:

1. interview five operators, collect three consented redacted failures, compare
   the closest three products on the same incident, and recruit two browser
   design partners;
2. draft a Moa-only browser/gateway milestone model;
3. add endpoint-observed playout and bounded network QoE to the isolated Moa
   browser candidate only;
4. render one local timeline and prove it changes one diagnosis;
5. have the design partners validate setup cost and incident value;
6. only then freeze portable semantics and evaluate cohorts/replay;
7. add CI and diagnosis/candidate agents only after repeated usage proves that
   workflow is valuable.

The existing semantic telemetry exporter stays loss-tolerant and independent
of canonical product state. No external backend or production audio export is
enabled by this design.

## Decision gates

- Interview at least five teams operating browser-based voice agents, obtain
  three consented redacted failure examples, and recruit two design partners
  before building beyond the Moa-only draft.
- Demonstrate that endpoint-observed timing changes at least one diagnosis that
  server-only metrics would have misclassified.
- Validate installation effort and diagnosis value with both design partners
  before freezing a portable schema.
- Demonstrate one production-to-replay fixture with deletion lineage.
- Demonstrate one candidate that improves a frozen cohort and one deliberately
  gaming candidate that the gate rejects.
- Measure capture overhead, serialized event volume, spool/drop behavior, query
  performance, audio storage cost, and evaluator agreement before claiming
  production SLOs or pricing.
