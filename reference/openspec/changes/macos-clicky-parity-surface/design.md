# Design

## Product shell

`Ag` runs as an `LSUIElement` menu-bar application. `Control+Space` uses
the public Carbon hot-key registration API and invokes one app-owned `NSPanel`.
The panel is a top-attached Dynamic Island surface: on a notched built-in
display it is flush with the physical screen top and centered on the notch; on
other displays it sits immediately below the menu bar. The implementation uses
native AppKit/SwiftUI panel geometry informed by the MIT-licensed OpenClicky and
FreeFlow interaction patterns. It does not copy HeyClicky assets or require a
screen-capture grant.
If that system combination is already reserved, registration falls back to
`Option+Space` and the command panel shows the shortcut that actually won.
If neither registration succeeds, the menu-bar entry remains available and the
panel says to use it instead of silently advertising a broken shortcut.
App launch and the first summon show the same compact panel and begin one
latched voice capture. A second summon commits that capture; it never hides an
active microphone session. Escape explicitly cancels capture before hiding.
The summon and microphone control are toggles rather than hold-to-talk controls.
The panel uses a persistent colored boundary plus a short visual pulse and
trackpad haptics to confirm state changes. It does not add start, stop, pause,
cancel, copy, or finish sounds; routine audio is reserved for the assistant's
reply so repeated turns do not become noisy.
During capture, a short rolling waveform is computed locally from the PCM16
frames already destined for the gateway. Only bounded normalized levels enter
SwiftUI state; no second audio buffer or telemetry path is created.
Cancel is a dedicated control on the island's left and Finish is a dedicated
control on its right. Transcript and assistant message content lives below that
control row, wraps without a line limit, and scrolls inside the bounded panel.
The compact island retains the exact current submitted text and current reply;
durable gateway history is not rendered in this surface.
Settings and the existing screen-context grant UI remain in a normal deeper
window reached only through the menu-bar Settings action.

The top-attached panel is movable after its initial notch placement and saves
the user's position. It exposes Home and Agents modes in one 820-point native
workspace. Agents mode uses a narrow project sidebar and selected-run detail
pane. A separate transparent floating `NSPanel` parks at most six agent avatars
on the right edge of the active screen. The rail and the Agents workspace share
one observable model; selecting a parked avatar opens Agents. This adapts the
public AppKit pattern confirmed in OpenClicky and the installed HeyClicky binary
while using Ag branding, SF Symbols, and Chief Moa data.

Microphone denial remains visible in the island. The recovery state names the
Microphone pane, opens it only after a user action, rechecks permission when Ag
becomes active again, and offers an explicit retry. Screen Recording is labeled
as optional screen context and is never presented as a dictation prerequisite.

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

The compact panel creates no parallel conversation/history database and does
not present the durable history projection. History remains gateway-owned and
belongs in a deeper hosted workspace rather than the current-turn island.

The user configures the origin and signs in through the browser-backed device
flow. The non-secret origin is stored in app preferences. The revocable Ag
device bearer is cached in a portable `AG_HOME/auth.json` file, defaulting to
`~/.ag/auth.json`, with owner-only directory/file permissions and atomic
replacement. Explicit disconnect deletes the file. The cache follows Codex's
portable file credential-store pattern so the account is not tied to macOS.
Provider keys, vendor CLI OAuth tokens, and model-subscription tokens remain
gateway/execution-machine concerns.

The Mac reads bounded summaries from authenticated `GET /v1/agent/runs` and
requests cancellation through authenticated `POST /v1/agent/runs/:id/cancel`.
Both use the same canonical origin, portable Ag device session, redirect
rejection, ephemeral networking, and response-size boundary as the companion
surface. Run text is inert presentation and never becomes a local command. The
Mac does not create a parallel run database or inspect vendor CLI state to
populate the workspace.

## Privacy boundary

Summoning or submitting the command panel performs no AX traversal or screen
capture. The existing screen-context screen is a separate explicit product
grant with its own release mode, scope, preview, and revocation lifecycle.
Voice capture is separately user-invoked by app launch, the registered shortcut,
or the menu-bar Speak action. It sends only PCM and the bounded voice-session
envelope to the configured gateway; it does not inherit screen-context
authority.

Assistant voice sessions request `assistant_voice` delivery. Bounded assistant
text events update the inert reply presentation. An announced mono/stereo PCM16
format initializes the native audio engine; following binary frames are queued
in order and drained when the gateway sends `assistant_audio_done`. Unknown or
oversized audio formats fail visibly and never become executable content.

## Release boundary

Pull requests produce an ad-hoc-signed QA ZIP and SHA-256 as compilation and
packaging evidence. Developer ID signing, hardened runtime, notarization,
stapling, universal architecture, isolated TCC QA, rollback, and active install
remain promotion gates and must not be inferred from the QA artifact.
