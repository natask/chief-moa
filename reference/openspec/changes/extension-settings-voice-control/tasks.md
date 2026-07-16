## 1. Settings Surface

- [x] 1.1 Present the extension's settings (gateway URL/token, runtime profile fields incl. system prompt, model) in one settings surface.
- [x] 1.2 Read current values from the gateway (`GET /v1/agent/profile`) and local config; show what is in effect.
- [x] 1.3 Load model, voice, and language choices from the gateway profile-options catalog; render languages as searchable multi-select controls while persisting the existing gateway profile fields.
- [x] 1.4 Gateway: define a read-only catalog over every canonical runtime
      profile field and expose list, exact get, deterministic meaning/alias
      search, and recommendation through authenticated HTTP and the gateway
      voice agent. Results include effective/default values, scope, constraints,
      mutability, and redaction metadata; unknown ids fail closed.
- [ ] 1.5 Browser: merge the gateway runtime-profile catalog with an allowlist
      of extension-local settings. Every rendered browser control must have one
      stable catalog key, owner, and effective or redacted value. This task does
      not enumerate Android preferences.
- [ ] 1.6 Browser: route typed and spoken list, semantic search, compare, and
      recommendation queries to the catalog. Exact and paraphrased queries
      return grounded entries and never mutate state.
- [ ] 1.7 Browser: render query results as selectable setting rows in the existing
      command/workspace UI and deep-link into the focused Options control only
      for deep configuration or permission remediation. Typed and voice paths
      expose the same result identities and current values.

## 2. Change Settings By Talking To The Agent

- [x] 2.1 Add a settings-intent path: the agent can turn a spoken/typed request ("set the system prompt to ...", "be terser") into a concrete settings change.
- [x] 2.2 Apply agent-driven changes through the gateway profile endpoints (`PUT /v1/agent/profile`) and/or local config.
- [x] 2.3 Refresh the settings surface live so spoken changes appear without a manual reload.
- [x] 2.4 Route Chrome Live voice profile-control utterances through the same
      settings/profile path so voice and language changes apply on the next
      Live turn instead of staying as provider-only chat.
- [ ] 2.5 Broker writes by catalog owner and reject unknown keys. Gateway fields
      use the gateway profile API; extension-local fields apply only after local
      packaged-code validation; an unknown key creates no storage or profile
      change.

## 3. Verify

- [x] 3.1 Manual: speak/type a settings change to the agent; confirm it applies and the surface updates.
      Automated via `npm run smoke:settings` (Legs 2-3): typing "be terser" through the REAL on-page
      overlay routes to `PUT /v1/agent/profile` and the open settings surface refreshes live (140 chars,
      "customized" badge) with no manual reload.
- [x] 3.2 Manual: confirm a changed setting takes effect on the next turn with no restart.
      Automated via `npm run smoke:settings` (Leg 4): after "be terser" lowers `voice_max_chars` to 140,
      the next `POST /v1/voice/turns` returns a spoken reply capped to 140 chars — no gateway restart.
- [x] 3.3 Gateway: prove catalog completeness, list/get/search/recommend,
      current/default projection, redaction, unknown-setting rejection, HTTP
      handlers, and the live `read_agent_settings` voice tool. This is gateway
      profile evidence only, not browser visual projection or Android coverage.
- [ ] 3.4 Smoke one gateway-owned and one extension-local update and prove the
      owning surface refreshes to the effective value with an observable result.
- [x] 3.5 Browser: keep microphone failure on the active overlay/side panel,
      expose an explicit `Take me to microphone setup` action, and only then
      open Options with a typed one-shot recovery target, permission status, and
      focused Grant microphone control. Static verification rejects an
      unconditional Options redirect from the capture-error path.

### Verification notes

- `npm run smoke:settings` boots a LOCAL `gateway` instance (its working tree has the
  runtime agent-profile endpoints; the live gateway returns 404 for them) on a throwaway port with a
  throwaway `MOA_GATEWAY_TOKEN` and a throwaway `DATA_DIR`, running `node server.js` directly (not
  `npm start`) so the gateway's real `.env` is never loaded. No real secret is read or printed, and
  nothing is deployed. The headless quiet rules match `smoke:gateway` (throwaway profile, no window, no
  focus stolen).
- The local gateway runs with NO model key, so it returns its deterministic fallback reply; that makes
  the "next turn honored the new limit" proof (Leg 4) work without any provider secret.
- `npm run smoke:gateway` still passes against the live gateway: the settings-intent interception lets
  ordinary commands fall through to `POST /v1/voice/turns`, and the unauthorized loud-error path is
  intact (no regression).
