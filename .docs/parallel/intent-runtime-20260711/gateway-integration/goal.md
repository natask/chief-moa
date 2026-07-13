# Gateway integration slice

## Goal

Wire the independently audited intent runtime and voice-draft store into the
gateway so ordinary input is durable before routing, draft capture invokes no
provider/model/tool before SEND, and SEND enters the existing canonical voice
pipeline exactly once.

## Branch and worktree

- Branch: `agent/intent-gateway-integration-20260711`
- Worktree:
  `/Users/natnaelkahssay/projs/chief-moa-worktrees/intent-gateway-integration-20260711`
- Base: the audited staging head after S1 and S2 are merged.

## Owned files

- `gateway/server.js`
- `gateway/lib/voice-session-server.js`
- the intent and voice-draft router/adapter modules merged from S1/S2
- new focused gateway integration tests/smokes
- this slice's docs

## Do not touch

- Android or browser-extension source
- provider implementations
- audio-note semantics
- active app data, credentials, deployment refs, or live services

## Acceptance

1. Authenticated intent list/detail/rehydration and voice-draft CRUD/action/audio
   routes are bounded and authority-preserving.
2. Non-incognito chat, HTTP voice, cascaded/streaming voice, and broker input
   capture a canonical intent before route/model/tool/launch work.
3. Broker fault injection proves a failed intent capture causes zero route
   decisions and zero launches.
4. One profile mutation runs as a transactional child with focus push,
   versioned receipt/outcome, completion, and return to its parent.
5. Draft session start, PCM capture, pause, park, resume, discard, and unexpected
   close execute zero provider/model/tool calls.
6. SEND claims exact session/branch authority, assembles audio in order, creates
   one canonical voice turn, and invokes the existing commit path exactly once.
   A failed provider attempt leaves the draft retryable without content loss.
7. `/health` advertises `voice_drafts_v1` only when the complete route + store +
   WebSocket path is active.

## Verification

- Focused intent route/order/fault-injection tests.
- Focused draft HTTP/WS/provider-counter/restart/order tests.
- `cd gateway && npm run check`.
- Fresh correctness, privacy/trust, resource, compatibility, and no-gaming
  auditors before merge.

No commit, merge, preview, or deployment is green without the main
orchestrator rerunning these commands.
