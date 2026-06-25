## 1. Contract And Naming

- [x] 1.1 Record that `Aggie` is the canonical spelling and product/session
  layer; older `Agee` references are legacy names to normalize when touched.
- [x] 1.2 Record that Moa browser/mobile/desktop are compatible surfaces, not
  the canonical product session.
- [ ] 1.3 Update user-facing docs to consistently explain Aggie vs Moa without
  renaming unrelated packages in the same change.

## 2. Gateway Facade

- [ ] 2.1 Add `POST /v1/aggie/turns` as a facade over the broker message route.
- [ ] 2.2 Add `WS /v1/aggie/live` as a facade over existing voice sessions.
- [ ] 2.3 Add `GET /v1/aggie/sessions/:session_id/events` for subscribed
  surfaces.
- [ ] 2.4 Persist cross-surface session identifiers, turn identifiers, route
  decisions, run links, approval events, and artifact links.

## 3. Surface Integration

- [ ] 3.1 Add a MOA browser surface adapter that sends text, voice, URL, page
  title, selected text, and permitted page context through Aggie.
- [ ] 3.2 Render subscribed Aggie session events in the browser surface:
  assistant text, run status, approval prompts, and artifact links.
- [ ] 3.3 Confirm Android and desktop can use the same Aggie session/event
  identifiers.

## 4. Backend Adapter

- [ ] 4.1 Add backend adapter metadata and health output.
- [ ] 4.2 Add an echo backend adapter for deterministic smoke tests.
- [ ] 4.3 Add Hermes/OpenClaw only after the echo adapter and session facade are
  proven.
- [ ] 4.4 Keep STT/TTS owned by Aggie when a backend lacks native LiveVoice.

## 5. Verification

- [ ] 5.1 Smoke text turn: browser surface -> `/v1/aggie/turns` -> broker event
  -> route decision -> subscribed event.
- [ ] 5.2 Smoke LiveVoice: mobile/browser surface -> `/v1/aggie/live` -> final
  transcript -> route decision -> assistant text/audio event.
- [ ] 5.3 Smoke backend adapter: Aggie -> echo backend -> run event -> artifact
  link.
- [ ] 5.4 Verify no provider keys or canonical chat history are stored in the
  browser surface.
- [ ] 5.5 Run `openspec validate define-aggie-compatible-surface --strict`.
  Blocked in this checkout on 2026-06-24 because `openspec list` reports no
  root OpenSpec changes directory; this repo currently stores specs under
  `reference/openspec`.
