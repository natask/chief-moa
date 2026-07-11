# Proposal: Open voice reliability control plane

## Why

Chief Moa already records normalized voice stages, first-audio timing, provider
events, retained audio metadata, and self-hosted failure diagnoses. Those are
the beginnings of a product that other voice-agent teams repeatedly rebuild.

Generic LLM observability products can attach audio to a trace, and several
commercial voice-testing products now offer simulations, call scoring, and
latency dashboards. Several products also claim production replay, CI gates,
recommendations, or agent-assisted analysis. The opportunity is therefore an
unvalidated wedge hypothesis, not empty white space: an open, runtime-neutral
evidence plane that correlates backend work with endpoint-observed playout and
network quality, then applies privacy-preserving, no-gaming change control.

## What this change decides

- The first economic buyer is a voice-infrastructure lead for a browser-based
  realtime voice product that owns both the endpoint and gateway.
- The first repeated incident is "the server says it emitted audio, but the user
  experienced dead air or late playback."
- The MVP is one Chief Moa browser integration plus its Node gateway and one
  local synchronized timeline. It uses a draft schema and must prove that
  endpoint evidence changes a diagnosis that server-only evidence got wrong.
- Mobile SDKs, portable semantics, cohort warehousing, production replay, CI
  gates, and improvement agents are later gated milestones, not MVP scope.
- Generic CI optimization remains an integration rather than part of the voice
  product.

## Non-goals

- Replacing Datadog, Sentry, OpenTelemetry, or a general observability backend.
- Building a generic GitHub Actions runner or CI optimizer; StarSling and
  open-source CI agents already address that layer.
- Claiming that voice observability, audio storage, simulation, p99 dashboards,
  production replay, agent recommendations, or prompt optimization are empty
  categories.
- Autonomously editing, merging, deploying, or tuning a production voice agent.
- Supporting every telephony provider, emotion label, or contact-center workflow
  in the first product.
- Exporting raw audio, transcripts, identity, prompts, or credentials by default.

## Success statement

The MVP succeeds when one endpoint/gateway timeline changes a real diagnosis,
and two external design partners agree that its setup cost and evidence would
have shortened the same repeated incident. The longer-term product succeeds when
a team can move from that evidence to a privacy-safe, non-gameable, reviewable
improvement without granting an agent production authority.
