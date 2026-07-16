# Design

## Product shell

`MoaMac` runs as an `LSUIElement` menu-bar application. `Control+Space` uses
the public Carbon hot-key registration API and toggles an app-owned `NSPanel`.
If that system combination is already reserved, registration falls back to
`Option+Space` and the command panel shows the shortcut that actually won.
If neither registration succeeds, the menu-bar entry remains available and the
panel says to use it instead of silently advertising a broken shortcut.
The panel is centered on the active screen, can become key for text entry, and
hides on Escape. Settings and the existing screen-context grant UI remain in a
normal deeper window.

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

The user configures the origin and gateway bearer token. The origin has no
packaged default and is stored in app preferences. The token is stored in the
macOS Keychain. Provider keys, CLI OAuth tokens, and model-subscription tokens
remain gateway/execution-machine concerns.

## Privacy boundary

Summoning or submitting the command panel performs no AX traversal or screen
capture. The existing screen-context screen is a separate explicit product
grant with its own release mode, scope, preview, and revocation lifecycle.

## Release boundary

Pull requests produce an ad-hoc-signed QA ZIP and SHA-256 as compilation and
packaging evidence. Developer ID signing, hardened runtime, notarization,
stapling, universal architecture, isolated TCC QA, rollback, and active install
remain promotion gates and must not be inferred from the QA artifact.
