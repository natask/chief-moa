# Browser Draft Controls Repair Contract 4

## Audit disposition

`BLOCK`. The focused suites, verifier, and real-Chrome smoke pass, and the
incoming ready/ACK/terminal grammar is substantially stricter. Five adversarial
cases still violate the local-authority, release-boundary, lifecycle, and
capability-latching contracts.

## Release blockers

### 1. Malformed local expected authority can still become trusted authority

- `extension/voice-draft-protocol.js:101-110` converts a supplied invalid
  expected create draft ID to the same empty string used for absent authority.
  Consequently an incoming canonical create receipt can compensate for invalid
  local authority.
- `extension/background.js:2360-2364,2434-2445` still repairs caller draft,
  session, and branch authority with `String(...).trim()`. The same lossy repair
  occurs when content accepts the background start response at
  `extension/content.js:2767-2778`. Numeric and whitespace-padded values can
  therefore become canonical-looking expected authority before the shared
  validator sees them.

Adversarial reproduction using the actual validator returned success:

```json
validateReady(createReady, { ...createExpected, "draftId": " bad" })
=> { "ok": true, "pointer": { "draftId": "draft-1", "revision": 1 } }
```

Executing the actual `startLiveVoiceTurn` body with a background response whose
session and branch were `" session-1 "` and `" branch-1 "` also attached the
session and stored them as `"session-1"` and `"branch-1"`.

Repair: distinguish absent create authority from malformed supplied authority,
and reject the latter. Parse resume authority as one complete strict pointer at
the background boundary. Validate ticket, branch-switch, stored session, and
content start-response authority with the shared exact token grammar; never
trim or stringify protocol authority.

### 2. Releasing SEND before the start response does not stop capture

Fresh draft capture begins before ticket/socket readiness at
`extension/background.js:2379-2394`. On release, however,
`extension/content.js:3007-3031` sends `commit_turn` only when
`state.voiceSessionId` is already known. Otherwise it merely sets
`commitWhenReady`; no runtime message reaches background to stop and drain the
offscreen microphone.

Executing the actual `commitLiveVoiceTurn` body with an active draft state and
`voiceSessionId:null` produced:

```json
{"committed":true,"commitWhenReady":true,"runtimeMessages":[]}
```

Audio captured after physical release is therefore included until the WebSocket
opens and content finally receives the session ID. This violates the exact
release boundary and repair-audit-1's pre-ID requirement.

Repair: make authority-bound draft SEND discoverable by tab plus exact turn ID,
as pause/park/discard already are, or return an internal session handle before
the async open completes. Release must immediately stop and exactly drain
offscreen PCM, queue SEND behind that PCM, and emit neither PCM nor SEND to the
socket until canonical ready authority binds.

### 3. A canceled in-flight start can attach an orphan session later

`extension/content.js:2684-2785` does not recheck that its state is active after
awaiting `voiceSessionStart`. A cancel before the response has no session ID, so
`extension/content.js:3138-3148,3186-3205` cannot send control or close; it only
untracks the local state. When the old response resolves, line 2781 attaches the
already inactive state and leaves the background session and microphone alive.

Executing the actual start and stop bodies with a deferred start response
produced:

```json
{"active":false,"controls":[],"attached":[{"id":"late-session","active":false}]}
```

Repair: after every start await, require the same state to remain active before
attach. If cancellation won, close the returned session immediately and ensure
the background capture is stopped; draft cancellation must use discard/no-send
semantics when authority exists. Add a delayed-start cancellation race test.

### 4. An old endpoint's in-flight capability result can enable a new endpoint

On gateway URL/token change, `extension/content.js:3719-3723` invalidates the
capability and calls refresh. But `refreshVoiceDraftCapability` returns the old
in-flight promise at line 1269 without advancing the request generation. When
that response resolves, lines 1275-1279 ignore its `gateway_url` and re-enable
support for the newly configured endpoint.

Executing the actual refresh body with endpoint A pending, invalidation for B,
then A resolving supported produced one request and a final supported state:

```json
{"sends":1,"final":{"supported":true,"stale":false}}
```

An older gateway B may then receive draft `session_start` despite never
advertising `voice_drafts_v1`, defeating the pre-provider admission gate.

Repair: bind the content capability record to the normalized gateway URL, bump
the generation and detach from any old pending request on config change, and
ignore every response whose URL/generation no longer matches. A late success may
affect only a later gesture after the current endpoint has independently passed.

### 5. Feature changes destroy an already latched hold or tap chord

The gesture stores immutable admission in `dragState` and `voiceFirstTapChain`,
but the storage listener at `extension/content.js:3727-3732` calls both
`resetVoiceFirstTapChain()` and `clearVoiceFirstHoldTimer()` immediately. Turning
the flag off after the first tap cancels its deferred action entirely; changing
it during the pre-confirmation part of a still hold prevents that latched hold
from starting. This contradicts repair-audit-2's explicit mid-chord/mid-hold
latching requirement.

Repair: settings and capability changes apply to the next admission only. Do
not cancel or rewrite an active chain, pointer gesture, or hold timer. Add fake-
timer behavioral cases that flip the feature and capability during both paths.

## Confirmed non-blocking areas

- Persisted pointer aliases reject disagreement and strict revisions.
- ACK and terminal validators reject malformed expected authority/base revision
  and require exact newer receipts.
- Confirmed draft pointer cancellation emits discard and never SEND.
- Draft mode bypasses LiveKit.
- Offscreen PCM delivery is count-bounded, drain-timed, truthful on mismatched
  stop, and fail-closed on rejected delivery/backpressure.
- Directional action and per-chain capability admission remain latched once the
  hold/chord itself is not destroyed by the feature-change listener above.

## Gate evidence

- `npm run test:voice-draft-protocol`: pass
- `npm run test:voice-capture-gesture`: pass
- `npm run test:offscreen-voice-capture`: pass
- `npm run verify`: pass; 7 lifecycle tests pass; `extension verification passed`
- `npm run smoke`: pass against the real extension in headless Chrome for Testing
- `git diff --check -- browser_extension .docs/parallel/intent-runtime-20260711/browser`: pass

The green tests do not cover malformed local expected create authority, a SEND
released before the start response, cancel-before-start-resolution, endpoint
replacement while capability refresh is pending, or a feature flip during an
active chord/hold. Add those behavioral cases before requesting another audit.

No product/test code, commit, package, reload, merge, or deployment was changed
or performed by this audit.
