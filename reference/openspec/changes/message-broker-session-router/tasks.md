## 1. Broker Contract

- [x] 1.1 Define canonical `broker_event` fields: id, source, text/transcript, session/project/subproject hints, profile version, evidence refs, created_at.
- [x] 1.2 Define route decision fields: target type, target id, action, confidence, reason, context refs, and cancellation behavior.
- [x] 1.3 Add a gateway endpoint to accept a message and return stored route decisions. Implemented as `POST /v1/broker/messages`.
- [x] 1.4 Add a gateway history/search read model that returns brokered intents alongside voice and chat turns.
      Verified 2026-06-28 with `cd gateway && npm run smoke:message-broker` and `cd gateway && npm run check`.
- [x] 1.5 Index brokered intent summaries into gbrain as best-effort semantic recall hints while keeping broker events as source of truth.
      Verified 2026-06-28 with `cd gateway && npm run smoke:message-broker`.

## 2. Session / Project Candidate Lookup

- [x] 2.1 Expose active sessions, projects, active runs, and recent turns as broker candidates. Subproject records are still pending.
- [x] 2.2 Match messages to existing candidates using deterministic recency/text heuristics first.
- [x] 2.3 Keep every match reason inspectable.

## 3. Non-Interrupting Fanout

- [x] 3.1 Attach a message to relevant active runs without canceling them. Implemented by appending `broker_evidence_attached` events to matched active runs.
- [ ] 3.2 Allow a message to create a new forked run with `wait=false`.
- [ ] 3.3 Let irrelevant forked runs self-dismiss with a stored no-op reason.

## 4. Workflow Package Invocation

- [x] 4.1 Add workflow target metadata for research, coding, QA, design, writing, and direct-answer paths. Implemented in `gateway/agent-launcher-profiles.json`.
- [x] 4.2 Build focused workflow context packs from broker event + selected session/project context. Implemented as broker context packs stored under `DATA_DIR/broker-context-packs` and referenced by route decisions.
- [ ] 4.3 Add a research workflow path that can fan out search/model passes, refine, and return a report when the broker selects it.

## 5. Verification

- [x] 5.1 Add broker smoke coverage for auth, event persistence, existing-session continuation, new-fork recommendation, and active-run attachment. Current smoke covers auth, persistence, existing-session continuation, context-pack creation, research and QA workflow recommendations, new-fork recommendation, and active-run attachment.
- [x] 5.2 Add OpenSpec validation.
- [x] 5.3 Update architecture with broker/session/project routing boundaries.
