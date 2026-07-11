# Browser Generated Surface Implementation Contract

## Objective and non-negotiables

Deliver two deliberately separate capabilities without turning downloaded model
output into privileged extension code:

- **Tier B** renders a reviewed rich UI artifact in a packaged MV3 sandbox page.
- **Tier C** registers reviewed, user-provided page automation only through
  `chrome.userScripts`, after both Chrome's own enablement and a Moa approval.

The stable packaged extension remains the broker and policy authority. Gateway
artifacts are proposals. Tier B never receives Chrome APIs, extension storage,
gateway credentials, raw page DOM, or page-action authority. Tier C is disabled
by default and cannot be reached by changing a Tier B artifact.

This is a hard implementation contract, not authorization to implement it. If
the current manifest, artifact envelope, ownership, or approval/receipt store
cannot satisfy a requirement below, the implementer must stop and return
file-and-line evidence to the browser manager. It must not invent a parallel
architecture.

## Lane and ownership

- Branch: `agent/browser-generated-surfaces`
- Isolated worktree: assigned by the parent manager; never the live extension
  tree.
- Owned implementation area: `browser_extension/extension/` packaged renderer,
  broker, manifest, and tests; gateway artifact schema/routes only through a
  separately assigned gateway lane.
- Do not touch Android, provider routing, voice runtime, deployment scripts, or
  active gateway data.
- Adjacent gateway schema changes require a separate contract and serial merge.

## Platform facts and resulting constraints

Official Chrome sources establish the boundary:

- MV3 forbids remotely hosted extension logic; packaged extension logic must be
  reviewable. <https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3>
- A manifest `sandbox.pages` document is assigned a unique origin, has no
  `chrome.*` access, and communicates with the embedding extension page using
  `postMessage`. Its CSP is separate and cannot contain `allow-same-origin`.
  <https://developer.chrome.com/docs/extensions/how-to/security/sandboxing-eval>
- `chrome.userScripts` requires MV3, Chrome 120+, the `userScripts` permission,
  applicable host permissions, and user-controlled browser enablement. Chrome
  138+ exposes an extension-specific **Allow User Scripts** toggle; API calls
  can still throw after revocation, so every operation must handle failure.
  <https://developer.chrome.com/docs/extensions/reference/api/userScripts>
- User-script messaging has dedicated less-trusted handlers and is off unless
  `configureWorld({messaging:true})` enables it. The default world is
  `USER_SCRIPT`; `MAIN` shares the host page's JavaScript environment.
  <https://developer.chrome.com/docs/extensions/reference/api/userScripts>
- Optional host permissions should be requested from a user gesture and scoped
  to the minimum origins needed.
  <https://developer.chrome.com/docs/extensions/mv3/user_privacy/>

## Tier B contract: sandboxed rich UI

### Data flow

1. The broker fetches a token-guarded, versioned artifact envelope over the
   already configured gateway connection.
2. Packaged extension code validates type, schema version, byte/node/depth
   limits, provenance, approval state, content hash, and expiration. Invalid
   data is rejected before it reaches the frame.
3. Preview creates a fresh iframe whose `src` is one exact packaged page listed
   in `manifest.sandbox.pages`. No remote URL or artifact-selected page is used.
4. After load, the parent generates a cryptographically random per-frame nonce
   and sends `{protocolVersion, artifactId, revision, contentHash, nonce, spec}`
   through `postMessage` to the frame's captured `contentWindow`.
5. The sandbox validates the envelope again, renders only the allowlisted UI
   vocabulary, and replies with bounded status/intent messages containing the
   nonce, artifact identity, and revision.
6. The parent accepts messages only when `event.source === frame.contentWindow`,
   the nonce and artifact identity match the live preview, the message schema is
   valid, and the message is within rate/size limits. Because the sandbox has a
   unique opaque origin, sender authentication must not depend on a reusable
   origin string; send to the captured window and bind the session nonce.
7. Sandbox intents are proposals. The packaged broker maps an allowlisted intent
   name to an existing privileged operation and applies its normal permission
   and approval policy. Arbitrary method names, URLs, code, selectors, headers,
   and Chrome API arguments are rejected.

### CSP and content rules

- Manifest sandbox CSP must include `sandbox allow-scripts` and must omit
  `allow-same-origin`, `allow-top-navigation`, forms, popups, modals, downloads,
  and external network sources. Start with
  `sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'`.
- No remote scripts, styles, fonts, images, frames, modules, workers, WASM, or
  fetch/WebSocket/EventSource are permitted.
- Even though a sandbox may technically permit `eval`, this product contract
  forbids `eval`, indirect eval, `new Function`, string timers, dynamic import
  from artifact data, `javascript:` URLs, inline handlers, raw HTML insertion,
  and executable template languages.
- Rendering uses DOM construction/text nodes and enumerated attributes/styles.
  URL-bearing attributes are absent from v1. HTML/SVG strings and custom CSS are
  rejected, not sanitized.

### Preview, apply, revert, receipt

- Preview is visibly labeled, non-persistent, non-privileged, and cannot replace
  the active view until a direct user gesture selects Apply.
- Apply records artifact ID/revision/hash, prior active pointer, approver/user
  gesture, timestamp, validator version, and result. Apply is atomic: the last
  good artifact remains active on validation/render failure.
- Revert is one user action and restores the recorded prior pointer without
  regenerating content. Safe mode disables Tier B and loads the packaged base UI.
- Every preview/apply/revert/rejection emits a bounded receipt. Receipts exclude
  gateway tokens, page content, artifact source text beyond hashes, and user
  secrets.

## Tier C contract: explicit userScripts opt-in

### Enablement and permissions

- Tier C has a distinct settings switch defaulting off. Enabling it displays the
  inspected source, exact match patterns, run timing, world, requested message
  capabilities, risks, and removal path before any permission prompt.
- The flow checks `chrome.userScripts` by calling `getScripts()` and treating
  absence or rejection as unavailable. It explains the Chrome 138+ Allow User
  Scripts toggle (or Developer Mode on older supported Chrome) but cannot toggle
  it for the user.
- Host access is optional and requested from the approval click for the exact
  origin/match set. No blanket `<all_urls>` request, silent widening, or reuse of
  unrelated host permission is allowed.
- V1 registers into `USER_SCRIPT` only. `MAIN` world, all-frames execution,
  `about:blank`/data/blob matching, incognito, file URLs, browser-internal pages,
  and opaque origins are forbidden.
- Messaging is disabled by default. If a later artifact needs it, that is a new
  capability requiring explicit approval and a dedicated
  `runtime.onUserScriptMessage`/`onUserScriptConnect` validator. User-script
  messages never enter the ordinary trusted extension message handler.

### Registration, update, and recovery

1. Validate the immutable artifact and show a source/match diff against the
   currently approved revision.
2. Bind approval to artifact ID, revision, SHA-256 code hash, exact normalized
   matches/excludes, `document_idle`, and `USER_SCRIPT` world.
3. Request missing optional origin access from that approval gesture.
4. Recheck `getScripts()` and permission state, then register/update by a stable
   namespaced ID. Any mismatch between approval and registration aborts.
5. Read back with `getScripts({ids:[id]})` and emit success only if the effective
   registration exactly matches the approved record.
6. Revert unregisters the exact ID and verifies absence. Revoking Tier C removes
   every Moa-owned registration and optionally removes no-longer-needed host
   grants after showing impact.
7. Chrome clears scripts on extension update. Recovery may re-register only the
   last explicitly approved, hash-identical artifact after rechecking toggle/API
   and host access; otherwise it stays disabled and records why.

### Forbidden shortcuts

- Never route Tier C through `chrome.scripting.executeScript`, content-script
  string execution, CDP/debugger eval, Tier B, an offscreen document, or a remote
  script URL.
- Never accept model approval, approval inferred from chat, prechecked consent,
  background permission prompts, wildcard match widening, or hash-only source
  display.
- Never place gateway/provider credentials, extension privileged methods, or raw
  browsing history in user-script globals or messages.
- No auto-apply, time-delayed approval, approval reuse after source/match/world
  change, silent fallback to `MAIN`, or success receipt before read-back.

## Expected behavior and edge cases

- Malformed, oversized, cyclic/deep, stale, unknown-version, expired, or
  unapproved artifacts fail closed and preserve last-good/base UI.
- Frame reload/navigation, replayed messages, wrong nonce/hash/revision,
  duplicate intents, message floods, and destroyed previews cannot trigger a
  privileged operation.
- Missing/revoked Chrome toggle or host access, unsupported Chrome, registration
  parse error, partial update, extension update, navigation, service-worker
  suspension, and duplicate IDs yield explicit non-success state and receipts.
- Concurrent Apply/Revert operations serialize on artifact ID; stale revisions
  cannot overwrite a newer active pointer.

## Quality, complexity, performance, and resource targets

- New policy/validation modules: cyclomatic complexity <= 10 per function and
  CRAP <= 15 for changed functions, or a documented exception approved before
  merge. No duplicated validator between preview and apply.
- 100% branch coverage for trust-boundary validators, approval binding,
  message authentication, and registration read-back; >= 90% branch coverage
  for all other new modules. Mutation score target >= 90% for those boundary
  modules, with surviving mutants listed rather than excluded broadly.
- Tier B artifact caps must be explicit and tested: <= 128 KiB encoded, <= 500
  nodes, <= 20 depth, <= 100 messages/10 seconds/frame, <= 16 KiB/message.
- Preview p95 render <= 100 ms for the maximum valid artifact on the project CI
  fixture and no sustained timers/listeners after iframe removal. Tier C adds no
  persistent polling; operations are event/user driven.
- These are acceptance targets, not measured results. Record hardware, Chrome
  version, fixture, sample count, and raw output before claiming a measurement.

## Tests and acceptance commands

Required tests (names may follow repository convention but coverage may not be
weakened):

- manifest/CSP static test proves the exact sandbox page, no
  `allow-same-origin`, and no forbidden external/eval source;
- artifact schema property/fuzz tests cover limits and unknown fields;
- hostile postMessage tests cover wrong source, nonce, revision, hash, replay,
  flood, iframe replacement, and malformed payload;
- DOM/XSS corpus covers script/event/URL/SVG/CSS/prototype-pollution payloads;
- broker test proves sandbox messages can request only enumerated intents and
  still traverse existing approval policy;
- userScripts tests mock absence, thrown methods, revocation races, denied host
  permission, source/match/world drift, duplicate ID, failed update, read-back
  mismatch, uninstall/revert, and extension-update recovery;
- browser smoke in a dedicated profile proves preview/apply/revert/base safe
  mode and an opt-in user script on one local test origin, including removal;
- receipts test proves complete audit fields and secret/page-data redaction.

Acceptance commands from repository root:

```sh
cd browser_extension && npm run verify && npm run smoke
cd browser_extension && npm run test:coverage
cd browser_extension && npm run test:mutation
```

If `test:coverage` or `test:mutation` does not exist, adding a scoped,
reproducible command is part of the implementation; skipping the gate is not.
Runtime QA must use an isolated Chrome profile and separate local fixture origin,
never the user's loaded extension or active browsing session. Packaging and
active reload occur only after the repository's live-promotion gate passes.

## Required audit and claims ledger

Auditors must independently run correctness, security/trust-boundary,
performance/resource-efficiency, quality/CRAP/complexity, UX, integration, and
anti-gaming reviews. Every implementation claim uses:

```text
Implementer claim -> verified / refuted / unproven
Evidence checked -> file:line, test, benchmark, gate, or official source
Auditor verdict -> PASS / BLOCK / REPAIR REQUIRED
```

Anti-gaming audit must reject tests that merely grep source, mocked browser
success without read-back, ignored mutation survivors, excluded boundary code,
lowered limits, or architecture-confidence presented as measured browser
security/performance. Paid/external evaluations not run must be `NOT MEASURED`.

## Audit blockers and escalation

Block implementation or merge if any of these is unresolved:

- Tier B can choose executable code, remote content, privileged method names, or
  an origin/nonce-unbound message path.
- Tier C lacks source-and-scope inspection, direct approval, exact host access,
  API/toggle failure handling, isolated world, read-back, or verified removal.
- Gateway artifact provenance/approval or receipts have no authoritative owner.
- Browser tests require the active user profile, active gateway, or active data.
- Repository reality requires `MAIN` world, blanket hosts, relaxed CSP, remote
  code, or a second privileged execution route.
- Acceptance gates are missing and the manager declines the required tooling.

Any contradiction in architecture, ownership, or acceptance gates returns to
the parent manager as evidence. Implementers must not silently redesign it.
