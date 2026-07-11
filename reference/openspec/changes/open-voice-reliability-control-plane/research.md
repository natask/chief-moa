# Research snapshot: voice reliability and agent-powered CI

Date: 2026-07-10

This is a dated market and local-workspace snapshot. Product capabilities and
licenses can change; recheck primary sources before making a vendor or licensing
decision.

## Recovered references

The forgotten local pair is almost certainly Emdash and Superset.

- [Emdash](https://github.com/generalaction/emdash) is the stronger primary
  memory match. It is a YC W26, Apache-2.0, provider-agnostic desktop agent
  orchestrator. It runs coding agents in isolated Git worktrees and integrates
  tickets, terminals, diffs, pull requests, and CI checks. This workstation has
  its source under `/Users/natnaelkahssay/projs/emdash` and Emdash 0.4.45
  installed. Earlier local architecture notes explicitly analyzed Emdash as the
  reference orchestrator.
- [Superset](https://github.com/superset-sh/superset) is the likely competitor
  and the broader full-company-stack reference. It combines an Electron desktop
  app, web/API/admin/docs/mobile surfaces, local and hosted databases, sync,
  billing, analytics, previews, and release automation. It is a YC Spring 2026
  company. Its current checkout uses Elastic License 2.0, so it is
  source-available, not OSI open source. Its README and package metadata still
  say Apache-2.0; the root `LICENSE.md` is the controlling evidence and exposes
  that documentation inconsistency.
- The phrase transcribed as "Asian orchestration" was most likely "agent
  orchestration."

The name remembered as "Starslink" is almost certainly
[StarSling](https://www.ycombinator.com/companies/starsling), a YC Spring 2025
hosted GitHub Actions runner and optimization service. Its agents inspect run
history, logs, workflow structure, and machine telemetry, benchmark candidate
changes, and open reviewable optimization pull requests. Public customer
examples include [Mastra PR #15888](https://github.com/mastra-ai/mastra/pull/15888)
and [Better Auth PR #8073](https://github.com/better-auth/better-auth/pull/8073).
No public open-source core or license was found, so StarSling must not be
described as open source.

For an open-source CI agent, GitHub's MIT-licensed
[Agentic Workflows](https://github.com/github/gh-aw) and its
[CI Coach workflow](https://raw.githubusercontent.com/githubnext/agentics/main/workflows/ci-coach.md)
are the closest current starting point. CI Coach analyzes recent workflow data,
requires evidence and reversibility, and explicitly forbids hiding failures or
skipping tests merely to improve speed.

## Voice market correction

"Langfuse for voice" is not a novel category by itself.

- [Langfuse supports audio attachments](https://langfuse.com/docs/observability/features/multi-modality)
  and a [LiveKit OpenTelemetry integration](https://langfuse.com/integrations/frameworks/livekit).
  It remains generic: audio is attached media rather than a complete model of
  capture, turn taking, transport, provider work, device playback, and user
  experience.
- Voice runtimes expose meaningful raw evidence already. LiveKit documents
  [audio, transcripts, traces, tool calls, and turn latency](https://docs.livekit.io/deploy/observability/data/),
  while Pipecat exposes [OpenTelemetry spans and voice metrics](https://docs.pipecat.ai/api-reference/server/utilities/opentelemetry).
  Vapi exposes [recordings, logs, and call artifacts](https://docs.vapi.ai/security-and-privacy/retrieve-call-artifacts),
  and Retell documents [component latency](https://docs.retellai.com/reliability/check-actual-latency).
- Commercial voice QA and monitoring products include
  [Hamming](https://hamming.ai/), [Cekura](https://www.cekura.ai/),
  [Coval](https://www.coval.ai/), [Roark](https://docs.roark.ai/documentation/getting-started/introduction),
  and [Bluejay](https://getbluejay.ai/platform). Simulation, scoring, replay,
  audio issue detection, and production monitoring are established features.
- Open or self-hostable projects include
  [SoundFlare](https://github.com/TrilletAI/Soundflare),
  [VoiceTest](https://github.com/voicetestdev/voicetest),
  [LangWatch](https://github.com/langwatch/langwatch), and
  [Future AGI](https://github.com/future-agi/future-agi).

The name transcribed as "Azure" was likely
[Arize Phoenix](https://arize.com/docs/phoenix). Phoenix already provides
OpenTelemetry traces, datasets, replay/experiments on the same inputs, and a
permission-gated built-in agent. Phoenix is self-hostable under
[Elastic License 2.0](https://arize.com/docs/phoenix/self-hosting/license),
which is source-available but not an OSI-approved open-source license.

### Evidence matrix

This matrix records public claims found in the linked primary sources, not
independent product verification. "Not established" means the reviewed source
did not prove the capability; it does not prove the capability is absent.

| Product | Publicly claimed overlap | Endpoint-observed playout / network QoE | Runtime scope | Diagnosis or candidate loop | Self-hosting and license posture |
|---|---|---|---|---|---|
| [Langfuse](https://langfuse.com/docs/observability/features/multi-modality) | Audio attachments, traces, evals, LiveKit OTel integration | Not established as a first-class voice timeline | Generic AI/LLM traces | Datasets/experiments; voice-specific candidate agent not established | MIT core with separately licensed enterprise folders |
| [LiveKit](https://docs.livekit.io/deploy/observability/data/) | Audio, transcripts, traces, tools, per-turn latency | Partial; documented playback latency excludes client network delivery | LiveKit runtime | Cloud analysis; fixed-corpus candidate generation not established | Open runtime plus hosted observability; evaluate component licenses separately |
| [Hamming](https://hamming.ai/) | Production import, audio analysis, replay, OTel, CI regressions, recommendations | End-device network/playout proof not established | Multiple voice platforms | Recommendations and replay/CI comparison claimed | Hosted commercial service; no OSS core found |
| [Roark](https://docs.roark.ai/documentation/observability/traces) | Production monitoring, call replay, OTel traces, MCP | End-device network/playout proof not established | Multiple voice platforms | Analysis/replay and agent tooling claimed | Hosted commercial service; no OSS core found |
| [Cekura](https://docs.cekura.ai/documentation/integrations/livekit/tracing) | Production audio plus STT/LLM/TTS/EOU/tools/logs, simulations | End-device network/playout proof not established | Voice-platform integrations | Automated analysis and testing claimed | Hosted commercial service; no OSS core found |
| [Coval](https://www.coval.ai/) | Simulations, production evals, human review, audio issues, CI/CD | End-device network/playout proof not established | Multiple voice platforms | Regression workflow claimed; code-changing agent not established | Hosted commercial service; no OSS core found |
| [SoundFlare](https://github.com/TrilletAI/Soundflare) | Calls itself a voice-agent flight recorder; monitoring and evaluation | Not established | Trillet/LiveKit-centered | Evaluation; candidate loop not established | Self-hostable, MIT |
| [Phoenix](https://arize.com/docs/phoenix) | OTel traces, datasets, replay, experiments, permission-gated agent | Not voice/end-device specific | Generic AI/agent traces | Same-input experiments and built-in analysis agent | Self-hostable, ELv2 source-available |
| [LangWatch](https://github.com/langwatch/langwatch) | OTel, voice simulations, production-trace-to-test workflow | End-device network/playout proof not established | Generic agents plus voice testing | Evaluation/optimization workflows claimed | Apache-2.0 core, MIT SDKs, commercial enterprise modules |
| [Future AGI](https://github.com/future-agi/future-agi) | Observe, evaluate, simulate, optimize; voice integrations | End-device network/playout proof not established | Generic agents plus voice simulation | Agent/prompt optimization claimed | Self-hostable, Apache-2.0 |

## Unvalidated wedge hypothesis

Many competitors already cover production replay, testing, and recommendations.
The narrower hypothesis to validate is the intersection of these properties:

1. **Open and runtime-neutral semantics.** LiveKit, Pipecat, telephony vendors,
   browser/mobile clients, custom gateways, cascaded pipelines, and native-audio
   models should produce one honest model without inventing unavailable stages.
2. **Endpoint-observed experience.** Server first-byte time is not device
   playout time. A client observation remains a proxy unless acoustic loopback
   proves physical output, so the product must expose route/buffer/clock
   uncertainty rather than claim it literally measured hearing.
   Client audio receipt, jitter, packet loss, concealment, buffer delay, audio
   energy, and playout must correlate with backend traces. The browser source is
   the [W3C WebRTC stats API](https://www.w3.org/TR/webrtc-stats/).
3. **Tail and cohort diagnosis.** Query by release, model, provider, prompt,
   region, device, language, network class, and outcome, with sample counts and
   p50/p95/p99 rather than a single average.
4. **Privacy-safe, no-gaming change control.** A later candidate loop uses a
   frozen, independently hashed corpus; preserves all attempts and hard quality
   floors; exposes regressions; and waits for human approval.

## Local fit

Chief Moa already has the seed:

- normalized `stage_start`, `stage_done`, and `stage_error` provider events;
- STT, reasoning, TTS, completion, and first-audio timing;
- a token-protected `GET /v1/voice/diagnosis` path;
- canonical turn/provider-event storage and retained audio metadata;
- a bounded, failure-isolated semantic telemetry exporter seam.

The MVP gaps are a browser endpoint playout/network observation and a local
synchronized timeline. Columnar cohort queries, portable replay, CI, and the
candidate/PR loop remain later hypotheses.

Chief Moa's only current GitHub Actions workflow is a post-merge production
gateway verification and deploy-ref workflow. It has write permission and moves
`vps-deploy`; it is not an appropriate autonomous optimization sandbox. A
future voice regression check must be a separate read-only pull-request path
with no deployment authority.
