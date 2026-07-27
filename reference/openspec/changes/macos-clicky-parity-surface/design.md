# Design

## Product shell

`MoaMac` runs as an `LSUIElement` menu-bar application. `Control+Space` uses
the public Carbon hot-key registration API and invokes one app-owned `NSPanel`.
If that system combination is already reserved, registration falls back to
`Option+Space` and the command panel shows the shortcut that actually won.
If neither registration succeeds, the menu-bar entry remains available and the
panel says to use it instead of silently advertising a broken shortcut.
App launch and the first summon show the same compact panel and begin one
latched voice capture. A second summon commits that capture; it never hides an
active microphone session. Escape explicitly cancels capture before hiding.
During capture, a short rolling waveform is computed locally from the PCM16
frames already destined for the gateway. Only bounded normalized levels enter
SwiftUI state; no second audio buffer or telemetry path is created.
Settings and the existing screen-context grant UI remain in a normal deeper
window reached only through the menu-bar Settings action.

## Gateway boundary

The command surface creates a bounded JSON request for `POST /v1/chat`:

```json
{
  "session_id": "mac-...",
  "conversation_id": "mac-...",
  "source": "moa-macos",
  "messages": [{ "role": "user", "content": "..." }]
}
```

The origin must be canonical HTTPS, except HTTP loopback for local QA, with no
path, query, user info, or fragment. Redirects are rejected. The request uses
an ephemeral URL session with cookies and caches disabled. Input, request, and
response sizes are bounded. Only the returned `text` field is displayed; no
response field can directly execute a local action.

The history control uses the same canonical origin and in-memory bearer token
to read a bounded current-session projection from `GET /v1/history/messages`.
It presents that projection inside the panel. The token remains an
Authorization header rather than URL material, and the Mac app creates no
parallel conversation/history database.

The user configures the origin and gateway bearer token. The origin has no
packaged default and is stored in app preferences. The token defaults to empty,
exists only in process memory, and is cleared on explicit disconnect and app
termination. Apple runnable sources and configuration prohibit credential
persistence APIs. Provider keys, CLI OAuth tokens, and model-subscription
tokens remain gateway/execution-machine concerns.

## Privacy boundary

Summoning or submitting the command panel performs no AX traversal or screen
capture. The existing screen-context screen is a separate explicit product
grant with its own release mode, scope, preview, and revocation lifecycle.
Voice capture is separately user-invoked by app launch, the registered shortcut,
or the menu-bar Speak action. It sends only PCM and the bounded voice-session
envelope to the configured gateway; it does not inherit screen-context
authority.

## Release boundary

Pull requests produce an ad-hoc-signed QA ZIP and SHA-256 as compilation and
packaging evidence. Developer ID signing, hardened runtime, notarization,
stapling, universal architecture, isolated TCC QA, rollback, and active install
remain promotion gates and must not be inferred from the QA artifact.
