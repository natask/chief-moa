# agee

An open-source, browser-native interface shell. Hit **Cmd/Ctrl+,** or single-click the on-page control to type, drag it to move it, or double-click and hold it to talk directly on the website you are using. **Cmd/Ctrl+.** uses the same voice path: tap to start, tap again to commit, or hold to talk until release. The extension is a thin client for your agent gateway: the browser holds only gateway connection state, while the gateway owns model routing, provider credentials, state, and customization serving.

## Principles

- **You own it.** Open source. Not a silo — a unifying layer over the surfaces you already use.
- **Bring your own engine.** Your intelligence and your data are personal. The browser points at your self-hosted or hosted agent gateway; provider keys and subscriptions stay on that engine, not in the extension.
- **Interface first.** This is not a sidebar or a separate browser agent. It is a small, movable surface on the page that can grow into user-owned workflows.
- **Browser native.** The browser is the first surface because it is where the user's work already lives and where an extension can safely start with explicit user invocation.
- **Self-host or hosted.** Same extension package whether the engine runs on your machine or a hosted gateway; switch by changing the gateway URL/token.

## Status

MVP - a Chrome (Manifest V3) extension you can load unpacked today.

**Works now:** Cmd+, text intent field · Cmd+. gateway Live voice tap/hold with live transcript/reply feedback above the input · on-page Moa mark · a controlled localhost dev page · a developer-only reload bridge for unpacked-extension work · gateway-routed command/describe turns · runtime profile settings that read/write through the gateway · constrained browser actions on low-risk pages · one-current-intent overlay state with no visible scrollback.

**Next:** engine-served declarative UI spec · userScripts opt-in walkthrough · richer voice mode · cross-navigation task continuity · MOA integration · hosted/self-hosted engine switching.

## Privacy defaults

By default, loading a fresh or migrated extension does not contact a gateway. A
persisted, current background-automation opt-in intentionally starts claim
polling and heartbeat when the service worker loads. A fresh install does not
silently save or contact the packaged hosted destination, and background task,
agent-task, tool-request polling, and device heartbeat are off until you accept
the current background-automation disclosure in Options. If enabled, heartbeat
contains operational client identity and a bounded tool manifest—not the active
tab URL/title or browser-owner metadata.

The former **Local suggestions for this tab** control has been removed. It
classified pages from structural counts while withholding page meaning, so its
generic suggestions gave the model too little context to be useful and the
label looked like an agent role.

The future privacy direction is explicit context choice, not automatic context
starvation. A user should be able to allow page text while denying a screenshot,
optionally extract/summarize/redact and preserve a local version, inspect the
exact outbound payload, and then approve richer context for the normal browser
turn. Privacy means informed control over collection, local transformation,
retention, and release.

## Develop it (quiet by default)

Development is **headless and off-screen**. It drives **Chrome for Testing**
(from the puppeteer cache) with a throwaway profile — never your daily
Chrome/Brave — so it never opens a window, never steals focus, and never
prompts. Branded Google Chrome hard-blocks `--load-extension`; Chrome for
Testing allows it and loads the real agee service worker.

```sh
npm run dev
```

That single command:

1. Serves the demo page at `http://localhost:7777/fixtures/demo.html`.
2. Launches a headless Chrome for Testing instance that loads [extension/](extension/) and prints the stable extension id.
3. Watches [extension/](extension/) and [fixtures/](fixtures/). On every edit it reloads the real extension in the background via `chrome.runtime.reload()` (or, when the headless service worker has gone dormant, by transparently relaunching the headless instance). No window appears either way.

Options:

- `npm run dev -- --port 8080` — change the localhost port.
- `npm run dev -- --no-browser` — run just the dev server (pair with the manual visible route below).

Prerequisite: Chrome for Testing must be in the puppeteer/playwright cache. If
it is missing, install it once with `npx @puppeteer/browsers install chrome@stable`,
or point `AGEE_CHROME_PATH` at a Chrome for Testing binary. Throwaway profiles,
logs, and screenshots are written under `.gstack/background-qa/` (git-ignored).

## See it (explicit, opt-in only)

The default loop above is intentionally invisible. When you actually want to
*watch* the extension on screen, this manual route is the only one to use — it
is separate from the quiet flow on purpose:

1. Run `npm run configure`. This bakes the gateway URL and token into
   `extension/agee.config.json` (git-ignored), so the extension works on load
   with no Options visit. For a VPS gateway, pass
   `AGEE_GATEWAY_URL=https://api.agee.app` and `AGEE_GATEWAY_TOKEN=...` (or
   `MOA_GATEWAY_URL` / `MOA_GATEWAY_TOKEN`) in your environment. Legacy
   private-network installs can still read the token from the main machine over
   SSH; hosted HTTPS configs require an explicit env token. Tokens are never
   printed.
2. Run `npm run doctor`. It confirms the baked gateway URL/token, exercises the
   live gateway with that token, and reports whether a daily browser profile has
   agee loaded from this repo path.
3. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the [extension/](extension/) folder. If agee is already listed, click its reload icon and confirm the path shown in the card is this folder. It stays installed across browser restarts.
4. Open the agee toolbar icon → Options → **Grant microphone** once if you plan to use voice. That grant belongs to the extension, not to the websites where the overlay appears.
5. Open any low-risk page (or run `npm run dev -- --no-browser` and open `http://localhost:7777/fixtures/demo.html`).
6. Press **Cmd+,** (Mac) / **Ctrl+,**, type `test`, hit Enter. A healthy gateway-backed install should render a short reply such as `Hello, Captain.` or `Hi Captain.`. If you see an error mentioning an Anthropic key, Chrome is running an old extension/service worker; reload the agee card or remove the old copy and load [extension/](extension/) again.

The Moa mark floats on the page when idle, glows while it works, and rings
(a short chime plus a ring pulse) when a turn finishes, errors, or needs you.
Typed replies render above the command input; responses, errors, and voice turns
never clear or replace the draft in the command input. Voice keeps the same input surface available: partial and
final transcript feedback appears above the input while you speak, and assistant
text streams into the result stack above the input. The extension does not
render visible chat history; session history stays on the gateway and can be
queried by asking Moa.
Voice uses an extension offscreen document for microphone capture, so websites
do not need per-site microphone approval for A.G. turns. Capture starts before
the gateway has finished opening the voice session; early PCM chunks queue until
`session_ready`, then flush in order before any commit so the first syllables are
preserved. Cmd/Ctrl+. and the Moa mark's legacy double-click share one voice contract:
quick tap/double-click toggles a manual turn on, the next quick press commits
it, and holding Cmd/Ctrl+. or the second mark click captures only for the hold
and commits on release. The Moa mark mirrors Android for text and movement:
single click opens the chat menu, and click-and-hold while moving drags the
mark.
With experimental voice-first gestures enabled, one mascot click toggles manual
capture in the current thread: click once to start, then click again to stop and
send. Holding the mascot keeps push-to-talk in that thread and sends on release.
A double-click uses the same start/stop toggle in a fresh thread, while a
triple-click cancels any pending capture without sending and opens chat.
If Chrome blocks offscreen microphone capture, the overlay shows a visible
permission error and opens the A.G. Options page; grant the microphone there or
set Microphone to Allow for the extension from `chrome://extensions`.
Explicit open-tab commands such as `open https://example.com in a new tab`
create a browser tab locally; open-and-report requests still run through the
background browser task path with receipts.
To override the baked defaults, use the **agee** toolbar icon → Options.

Only while developing the extension package, optionally open
`chrome-extension://<extension-id>/dev.html?server=http://localhost:7777` in
that browser to get the in-page reload bridge for this manual session. Enable
**Auto-reload this loaded extension from the dev server** there if you want the
already-loaded unpacked extension to keep watching the local dev server after
the bridge tab closes. When enabled, active content scripts poll
`/__agee-dev/version`, the service worker calls `chrome.runtime.reload()` on
source changes, and localhost tabs refresh after the extension restarts. This is
a developer convenience for unpacked-extension work, not an end-user deployment
or customization path.

Manual reload proof:

1. Run `npm run dev -- --no-browser`.
2. Open `chrome-extension://<extension-id>/dev.html?server=http://localhost:7777`
   from the unpacked extension loaded out of this repo.
3. Enable **Auto-reload this loaded extension from the dev server**, then close
   the dev bridge tab.
4. Keep `http://localhost:7777/fixtures/demo.html` open and edit a file under
   [extension/](extension/), for example a harmless text change in `dev.html`.
5. The loaded extension reloads without clicking the `chrome://extensions`
   reload icon, and the localhost demo tab refreshes after the extension
   restarts.

Local deployment for an already-loaded unpacked extension:

```sh
npm run verify
npm run smoke
npm run package
npm run deploy:browser
```

`deploy:browser` sends a local dev-reload signal. If `npm run dev` is already
serving `localhost:7777`, deploy asks that running server to bump
`/__agee-dev/version`; otherwise it briefly serves the endpoint itself. If the
unpacked extension has auto-reload enabled from `dev.html`, your daily browser
reloads the extension from this checkout. If auto-reload has not been enabled,
the package is still produced under `dist/`, but the browser needs the one-time
`dev.html` toggle above or a manual `chrome://extensions` reload.

## Verify it

Run:

```sh
npm run doctor
npm run verify
npm run smoke
(cd ../gateway && node scripts/smoke-browser-voice-ticket.js)
```

`doctor` is the fast operational test for the default gateway setup. It checks
that current source no longer contains the old browser-side Anthropic fallback,
confirms `extension/agee.config.json` has the live gateway URL and a token
without printing the token, posts a real authenticated turn to
`/v1/voice/turns`, and scans common Chrome/Chromium profiles for an agee install
that points at this checkout. A warning that no daily profile has agee installed
means the headless tests can pass while the browser you are looking at is still
missing or stale.

`verify` checks that the MV3 manifest parses, required files exist, required
permissions/commands are present, and the extension/harness JavaScript has valid
syntax. It also fails if microphone capture moves back into the content script.

`smoke` launches headless Chrome for Testing with a throwaway profile, loads the
real [extension/](extension/), and confirms the agee background **service worker**
loads with a stable id. It then drives the real background → content-script
message path (`snapshot`, `type`, `click`) against the demo page and captures a
screenshot — no window shown, no focus taken. It exercises the **real** extension;
if the resolved Chrome ever refuses `--load-extension`, smoke fails loudly rather
than falling back to a content-script harness.

`smoke-browser-voice-ticket` proves the browser Live voice path at the gateway
boundary: the extension-style client mints a short-lived ticket over authenticated
HTTP, opens a headerless WebSocket to `/v1/voice/sessions`, sends PCM16 audio,
and receives assistant PCM audio back. Browser voice is not Web Speech API
dictation; provider credentials stay on the gateway.

`smoke:ambient` proves the 200 ms ambient frame loop with the real extension and
a throwaway local gateway. It sends `{cmd:"ambientStart", intervalMs:200}` from
the content script, observes repeated service-worker `POST /v1/voice/frames`
calls, and confirms the gateway stores the frame records. This is intake only:
it does not run a model every 200 ms.

## Verify the gateway round-trip

The overlay does not talk to the model vendor directly. It talks to **your**
agent gateway. `smoke:gateway` proves that path
end to end, headless and off-screen (same quiet rules as `smoke`):

```sh
npm run smoke:gateway                        # health + loud-error legs
AGEE_GATEWAY_TOKEN=<token> npm run smoke:gateway   # + authenticated legs
```

It loads the real extension, writes the gateway URL + token into
`chrome.storage.local` (exactly as the Options page does), opens the overlay, and
drives real `run` / `describe` submits while a `fetch` recorder in the service
worker observes which gateway path produced each rendered reply. The default
gateway is the main-machine one (`http://10.147.17.10:8787`); use
`AGEE_GATEWAY_URL=http://10.147.17.6:8787` or `npm run configure:local` when
intentionally testing against this Mac's local gateway.

**Confirmed round-trip sequence (what the smoke asserts):**

1. **Health** — with the URL configured, `GET /health` returns `200 {ok:true}`
   (no token needed). This is the reachability gate.
2. **Command** — an ordinary command submitted in the overlay is sent as `run` →
   `background.js` `POST /v1/voice/turns` (with `Authorization: Bearer <token>`)
   → the gateway's `display`/`text` reply renders above the command input without
   clearing or replacing its draft.
   The recorder confirms the reply originated from `/v1/voice/turns`.
3. **Page context** — "describe page" and page/current-page questions collect
   page evidence, post it to `/v1/browser/evidence`, then send the turn to
   `/v1/browser/turns`. The gateway reply renders in the same one-current-intent
   result surface, and returned actions are proposals only.
4. **Loud failure** — pointed at the gateway with **no/invalid token**, the same
   command hits `POST /v1/voice/turns`, the gateway returns `401`, and the
   overlay renders the clear error above the preserved input draft with a red status dot.
   The failure is visible, never silent.

The bearer token is read **only** from `AGEE_GATEWAY_TOKEN` at run time (never
from a file, never printed — see [.env.example](.env.example)). Without it, legs
1–2 above are skipped (implemented, awaiting the token) while the **health** and
**loud-error** legs always run; the smoke does not fail just because the token is
absent.

## How it fits together

- [extension/manifest.json](extension/manifest.json) — MV3 manifest, no build step.
- [extension/content.js](extension/content.js) — the Cmd+, overlay, page perception, and action execution (the only part touching the DOM).
- [extension/background.js](extension/background.js) — routes turns to the configured gateway, captures screenshots, validates brokered page actions, and handles extension commands.
- [extension/options.html](extension/options.html) / [options.js](extension/options.js) — gateway URL/token and runtime profile settings that read/write through gateway profile endpoints.
- [extension/dev.html](extension/dev.html) / [dev.js](extension/dev.js) — developer-only in-page reload bridge for the manual visible dev session.
- [scripts/chrome-for-testing.mjs](scripts/chrome-for-testing.mjs) — resolves the headless Chrome for Testing binary and the quiet launch flags shared by the dev loop and smoke.

Model/provider calls live on the gateway, not in the page or extension service
worker, so provider credentials and subscriptions stay off the browser.

## Review artifacts

- [NEXT.md](NEXT.md) — cleaned product direction from raw notes.
- [docs/task-split.md](docs/task-split.md) — workstreams, delegated research, and next delegation candidates.
- [docs/research.md](docs/research.md) — prior art and build-vs-borrow decision.
- [docs/architecture.md](docs/architecture.md) — runtime boundaries, message contract, agent loop, and security rules.
- [docs/chrome-agent-surface.md](docs/chrome-agent-surface.md) — Chrome global command, desktop capture, and browser-based Moa decision note.
- [docs/customization.md](docs/customization.md) — customization and future userScripts path.
- [docs/validation.md](docs/validation.md) — demo script and validation questions.
- [LICENSE](LICENSE) — MIT license for the open-source promise.

`__LOG__.md` is raw thinking — not part of the product.
