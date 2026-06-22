## 1. Record The Decision

- [x] 1.1 Land `design.md` as the architectural decision record: thin client + persistent engine, the MV3 constraint, the A/B/C deployment tiers, and the open hosted-tier key-custody question.
- [x] 1.2 Reframe the three dependent changes (`extension-gateway-roundtrip`, `extension-settings-voice-control`, `extension-ui-self-extension`) to "thin client + engine-as-deploy-target," noting deployment never repackages the extension.

## 2. Thin-Client Boundary

- [x] 2.1 Establish that the extension holds only a session token to its engine, not API keys/subscriptions; identify what must move off the browser. Done: removed the Anthropic API-key path entirely — `callClaude`, `API_URL`, the `ageeApiKey`/`ageeModel` storage and Options fields, and the `api.anthropic.com` host permission. The browser now holds only `gatewayUrl` + `gatewayToken` and routes every turn to the gateway.
- [x] 2.2 Make the engine the route for meaningful actions: the extension calls the engine even where it could call a provider directly. Decision (user override): no BYO-key escape hatch is kept — the in-browser provider path was removed outright, so the gateway is the only route. `describePage`/`runAgent` now error asking for a gateway URL instead of falling back to a local key.
- [x] 2.3 Demote the local disk-reload dev loop to a developer-only convenience, off the user-facing path (no promote-gate, no end-user reload).

## 3. Engine As Deployment Target

- [ ] 3.1 Engine serves a per-user declarative UI spec (tier A) the extension renderer interprets; changes live-refresh via the existing `storage.onChanged` pattern.
- [ ] 3.2 Bound the sandboxed paths: define where tier B (sandboxed iframe) and tier C (`userScripts`, explicit per-extension opt-in) apply and how generated code stays inspectable.
- [x] 3.3 Keep browser-facing work lanes browser-native: gateway console projects deep-link by URL and expose an explicit browser-tab open path instead of adding nested workspace tabs.

## 4. Verify

- [ ] 4.1 Confirm a customization round-trips engine → client (spec change reflected live) with the extension package unchanged.
- [ ] 4.2 Confirm the same client works against a self-hosted engine URL and a hosted engine URL with no client code change.
- [x] 4.3 Confirm the explicit ambient loop posts `/v1/voice/frames` at the 200 ms target cadence through the real extension service worker and stores frame records on a throwaway gateway. Verified by `cd browser_extension && npm run smoke:ambient`.
