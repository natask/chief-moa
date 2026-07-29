# Browser Context And Page-Edit Verification — 2026-07-29

## Outcome

The real Chrome extension smoke now proves one explicit Collaborate turn can
observe the current page and apply one packaged, bounded page edit. The same
smoke proves an unsupported click-shaped proposal remains inert.

## Observed Context

The grounded turn posted all of the following to `/v1/browser/evidence` before
the gateway response completed:

- current URL and title;
- a bounded semantic projection with an interactive-element index;
- whole-rendered-document text, including an offscreen fixture marker;
- document-context scope and completeness metadata;
- viewport and capture-time metadata; and
- one bounded current-viewport JPEG.

Gateway verification separately proves the stored JPEG is attached to the
reasoning-model request. Browser automation unit tests prove the profile grants
page-local `Runtime.evaluate` and bounded CDP methods while denying cookie,
storage, credential-origin, browser-wide, secret-evaluation, and screenshot-byte
return paths.

## Changed Page Capability

The fake gateway returned a typed `page_tweak` proposal with kind `black` for
the explicit Collaborate turn. Packaged extension code validated and compiled
the record locally, applied it to the fixture origin, and the smoke observed the
live body background become `rgb(0, 0, 0)`.

The independent tweak smoke also proved per-origin isolation, persistence after
reload, exact removal/undo, rejection of an unknown `inject-script` kind, and
no focus theft. Its cleanup now retries transient macOS/Chrome profile removal
races instead of turning a fully passed behavior check into a false failure.

## Verification

- `cd browser_extension && npm run verify` — passed, 188 unit tests plus the
  repo-wide source-size policy.
- `cd browser_extension && npm run smoke` — passed in real headless Chrome.
- `cd browser_extension && npm run smoke:unified-browser-agent` — passed with
  three evidence-linked browser turns; the grounded bounded page edit applied.
- `cd browser_extension && npm run smoke:tweaks` — passed in real headless
  Chrome, including validation, origin scope, persistence, and undo.
- `cd browser_extension && npm run smoke:cdp` — passed in real headless Chrome;
  bounded `Runtime.evaluate` and screenshot succeeded, secret CDP was denied,
  an owned background task dispatched input, and exact tab cleanup succeeded.
- `cd gateway && npm run check` — passed.
- `openspec validate browser-situated-agent-experience --strict` — passed.

## Boundary And Release Status

DOM text and pixels remain evidence, not authority. Only Collaborate or Delegate
may receive the narrow `page_tweak` tool, and the extension still validates and
executes the record locally. Raw generated HTML, CSS, JavaScript, cookies,
credentials, and browser storage are not exposed by this path.

No package, browser reload, preview, publication, or active promotion was
attempted because this switchboard execution grants no deployment capability.
The next authorized release owner should package and reload the committed
extension candidate through `bash scripts/deploy.sh extension` after confirming
the browser is idle.
