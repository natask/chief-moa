# Browser Audio-Note Promotion Evidence — 2026-08-03

The browser voice-note library now gives each selected stored note an explicit
`Prepare transcript` action. Before the authenticated
`POST /v1/capture-blocks`, the extension persists a note-scoped client
idempotency key in `chrome.storage.local`. A failed request therefore retries
the same promotion instead of creating a second capture identity.

The note card keeps stored, queued, transcribing, transcribed, and failed states
distinct. State refresh reads the exact returned capture-block identity. A
transcript preview is shown when the block contains one. Capture alone still
starts no assistant turn, handoff, or agent run.

After the gateway gained terminal schema-v2 transcript binding, the browser
added a separate `Send to Switchboard` action. It is absent for stored, queued,
transcribing, and failed blocks. It appears only when both the capture block and
its immutable transcript result are terminal. A browser confirmation names the
execution consequence before the authenticated handoff POST can occur.

The returned admission, raw-intent identity, compiled-intent identities, and
state are retained with the note-scoped promotion record and survive panel
restart. Retrying posts the same block-bound confirmation to the gateway, whose
durable receipt prevents a duplicate Switchboard admission. A changed
transcript result clears the old client receipt before another handoff can be
shown.

The terminal note card now captures the execution goal separately from the
literal transcript. The user must enter a desired outcome and at least one
newline-separated acceptance criterion. Chief shows those exact fields in the
execution confirmation, persists the confirmed goal before the outbound request
so a response-loss retry cannot mutate it, and emits contract v2. The gateway
requires Switchboard to echo both fields and retains them with the source-bound
receipt. It never invents a goal from transcript text. Callers without confirmed
goal fields retain the v1 source-only compatibility path.

Verification now includes 278 browser unit tests and the real headless extension
and side-panel smokes. Confirmed-goal contract v2 is packaged as version
`0.1.146` at `browser_extension/dist/Ag-0.1.146.zip`. It was deliberately not
sent a reload signal because production Chief remains on the incompatible
gateway predecessor. The earlier `0.1.145` deploy marker does not prove that
this v2 candidate is loaded. Installed-browser proof and active promotion remain
open.
