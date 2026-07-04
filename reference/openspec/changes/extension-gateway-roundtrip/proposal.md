## Why

With the extension loaded, the next proof is that the on-page overlay actually
talks to the user's gateway end to end. `background.js` already routes commands
to `/v1/voice/turns` and describe to `/v1/chat`, but this path has not been
confirmed live from a real browser.

This is the **first concrete slice of `thin-client-gateway-architecture`**: it
proves the load-bearing route — the thin-client extension reaching its persistent
engine — that everything else (settings, customization, deployment) is built on.
The point being confirmed is not just "a reply renders" but "the reply came from
the engine," i.e. the browser routed the action through the engine rather than
acting on its own.

This slice does **not** make the extension a deployment target. The installed
package remains unchanged; the proof is that the stable client can route work to
its configured engine.

## What Changes

- With a gateway URL + token configured, open the overlay via Cmd+Comma, submit a
  command, and confirm the reply came from `/v1/voice/turns`.
- Run "describe page" and confirm the output came from `/v1/chat`.
- Capture a clear failure message when the gateway is unreachable or unauthorized.
- Keep the extension package unchanged during the round trip; any behavior comes
  from the configured engine, not from a browser-side provider call or reload.

## Capabilities

### New Capabilities

- `extension-gateway-roundtrip`: A confirmed end-to-end path from the overlay
  through the configured gateway for both command and describe.

## Impact

- `software/browser_extension/extension/background.js`,
  `options.js` (gateway config). Gateway endpoints unchanged. Depends on
  `extension-browser-baseline`; first slice of `thin-client-gateway-architecture`.
