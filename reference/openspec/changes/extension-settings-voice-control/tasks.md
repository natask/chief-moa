## 1. Settings Surface

- [x] 1.1 Present the extension's settings (gateway URL/token, runtime profile fields incl. system prompt, model) in one settings surface.
- [x] 1.2 Read current values from the gateway (`GET /v1/agent/profile`) and local config; show what is in effect.

## 2. Change Settings By Talking To The Agent

- [x] 2.1 Add a settings-intent path: the agent can turn a spoken/typed request ("set the system prompt to ...", "be terser") into a concrete settings change.
- [x] 2.2 Apply agent-driven changes through the gateway profile endpoints (`PUT /v1/agent/profile`) and/or local config.
- [x] 2.3 Refresh the settings surface live so spoken changes appear without a manual reload.

## 3. Verify

- [x] 3.1 Manual: speak/type a settings change to the agent; confirm it applies and the surface updates.
      Automated via `npm run smoke:settings` (Legs 2-3): typing "be terser" through the REAL on-page
      overlay routes to `PUT /v1/agent/profile` and the open settings surface refreshes live (140 chars,
      "customized" badge) with no manual reload.
- [x] 3.2 Manual: confirm a changed setting takes effect on the next turn with no restart.
      Automated via `npm run smoke:settings` (Leg 4): after "be terser" lowers `voice_max_chars` to 140,
      the next `POST /v1/voice/turns` returns a spoken reply capped to 140 chars — no gateway restart.

### Verification notes

- `npm run smoke:settings` boots a LOCAL `software/moa_gateway` instance (its working tree has the
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
