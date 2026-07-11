# Client semantic-reduction audit

## Scope and counting method

Read-only audit of `browser_extension/extension` and `android_app/app/src/main`. Tests, verification scripts, vendored code, generated build output, packaging, and deployment code are excluded from the production baseline. Counts are physical lines from `wc -l`; nonblank counts are also reported because comments and formatting are deliberately not the optimization target.

| Surface | Physical production LOC | Nonblank production LOC | Notes |
| --- | ---: | ---: | --- |
| Browser extension runtime | 13,354 | 12,529 | JS, CSS, HTML; excludes `extension/vendor` |
| Android Java runtime | 11,613 | 10,481 | `app/src/main/java` |
| Android resources | 106 | 105 | `app/src/main/res` XML |
| **Client total** | **25,073** | **23,115** | Tests are intentionally outside the target |

The useful reduction metric is production nonblank LOC at unchanged observable behavior. Minification, joining statements, deleting comments, moving code into generated files, or shifting client logic to the gateway without an architectural reason does not count.

## Concentration and state-machine inventory

### Browser

| Module | Physical LOC | Responsibilities that make it risky |
| --- | ---: | --- |
| `extension/background.js` | 4,462 | gateway transport, tab ownership, task polling, CDP, ambient capture, voice sockets, offscreen lifecycle, settings/profile mutations, dev reload |
| `extension/content.js` | 3,677 | root lifecycle, overlay DOM, two gesture modes, cues, UI-spec rendering, companion rendering, voice state/playback/recovery, record mode, hotkeys |
| `extension/overlay.css` | 1,307 | launcher, command surface, cues, declarative components, companion and multiple state variants |
| `extension/options.js` | 859 | gateway enrollment, profile/catalog/companion configuration, experimental flags |
| `extension/sidepanel.js` | 491 | a second text/voice turn client, audio playback, watchdog and recovery |
| `extension/tweaks.js` | 470 | page-local customization/action behavior |
| `extension/settings-intent.js` | 410 | natural-language settings parser duplicated conceptually with gateway authority |

The two dominant files contain several independent state machines. `content.js` alone has launcher drag/click/hold timing, legacy and experimental gesture resolution, command-surface phases, cue lifetime, voice session/turn/playback recovery, record mode, hotkey resolution, and browser-agent ownership. `background.js` independently tracks browser ownership, task polling/claiming, CDP task execution, voice session/socket/offscreen state, ambient frame cadence, sampler lifecycle, caches, and dev reload.

### Android

| Module | Physical LOC | Responsibilities that make it risky |
| --- | ---: | --- |
| `OverlayService.java` | 3,649 | overlay DOM-equivalent UI, gesture callbacks, text/voice routing, voice state, playback fallback, agent run polling, action proposals, receipts, record mode |
| `MainActivity.java` | 1,229 | programmatic control-center UI, permissions, gateway health/profile/session/run/receipt reads, OTA download/verification/install |
| `MoaActionBroker.java` | 823 | local intent parsing, proposal validation, approvals and device actions |
| `MoaStreamingVoiceSessionController.java` | 821 | gateway streaming voice lifecycle |
| `MoaPrefs.java` | 607 | preference schema/defaults/formatting |
| `MoaGatewayClient.java` | 565 | HTTP API adapter and response parsing |
| `MoaVoiceController.java` | 558 | platform speech-recognition path |
| `MoaVoiceGatewaySocket.java` | 531 | WebSocket protocol adapter |
| `MoaOrbTouchListener.java` | 497 | legacy and voice-first pointer gesture recognition |

The Android complexity hotspot is not Java verbosity by itself: `OverlayService` owns at least five lifecycles (window/surfaces, gesture/capture, streaming turn, playback/TTS, agent polling). It also renders control-center-like state that exists in `MainActivity`.

## Concrete duplication and obsolete-path findings

1. **The UI-spec sanitizer exists twice in the same content-script realm.** `manifest.json` loads `ui-spec-runtime.js` immediately before `content.js`; `ui-spec-runtime.js` provides `AgeeUiSpecRuntime.sanitize`, while `content.js:1092-1234` contains a second sanitizer for tokens, actions, coordinates, controls, list items, markers, components, surfaces, and payloads. This is direct production duplication and risks validation drift.
2. **The stop-intent matcher is copied rather than shared.** `content.js:2633` explicitly labels its matcher an inline mirror of `stop-intent.js`; `background.js` imports the canonical module. The classic content-script constraint is real, but the manifest already demonstrates ordered shared classic scripts, so a small global runtime can be loaded before `content.js` as is done for UI specs.
3. **Two browser voice/turn UIs implement the same lifecycle.** `content.js` and `sidepanel.js` each own turn ids, transcript/reply accumulation, watchdogs, PCM playback queues, stop/close, socket-event handling, persistence recovery, and visible status. Different DOM is justified; duplicated protocol state is not.
4. **Options bypasses the background gateway adapter.** `options.js` builds headers, formats network errors, parses JSON, generates device identity, and directly calls health/session/profile/catalog/companion routes. `background.js` independently owns the effective configuration and authenticated request behavior. This produces two auth/error/cache semantics.
5. **The browser carries simultaneous legacy and experimental gesture grammars.** `content.js:568-917` branches between legacy single-click/double-click-hold and voice-first single/double/triple/hold timing. Options exposes the off-by-default flag. Android has the equivalent preference and branches in `MoaOrbTouchListener`, `OverlayService`, and `MainActivity`. A product decision to graduate one grammar can delete a compatibility matrix across both clients.
6. **The extension has two overlapping control surfaces.** The in-page overlay is specified as the one-current-intent surface, while the side panel presents a visible multi-turn card log. The thin-client contract says command entry, status and focused inspection only, and browser tabs should be work lanes. Keeping both is defensible only if the side panel has measured usage and a distinct acceptance contract.
7. **Android duplicates control/status presentation.** `OverlayService` builds chat/menu/status/settings-adjacent overlay surfaces while `MainActivity` builds the full control center. The project contract explicitly says the overlay stays fast and small and deep inspection/history/settings/approvals belong in the full app. Agent-run detail and configuration affordances should be tested against that boundary.
8. **Android retains parallel voice implementations.** `MoaVoiceController` (platform recognition), `MoaStreamingVoiceSessionController` plus `MoaVoiceGatewaySocket` (gateway PCM streaming), and local TTS fallback coexist. Some fallback is product-required, but production health identifies cascaded gateway voice as primary. Unsupported or unobserved compatibility legs should not survive solely because they compile.
9. **CSS encodes runtime branches rather than one component vocabulary.** At 1,307 lines, `overlay.css` styles bespoke launcher, cues, control surface, pet/avatar, UI-spec components, gesture/voice phases, and review states. The declarative renderer and hand-built overlay use parallel visual primitives. Consolidating tokens and component classes can remove rules and reduce selector matching/recalculation; minifying CSS is explicitly not a reduction.

## Test and evidence hierarchy

Every deletion candidate should have a behavior inventory first. The hierarchy is cumulative: higher tiers do not replace lower tiers.

| Tier | Evidence | Required use |
| --- | --- | --- |
| T0: static contract | manifest/schema validation, compilation, lint, forbidden API/secret checks, production LOC delta | Every change; catches packaging and trust-boundary regressions cheaply |
| T1: pure behavior model | table/property tests for reducers, gesture traces, intent parsing, transcript merging, ownership and terminal-state invariants | State-machine changes; fastest exhaustive edge coverage |
| T2: adapter contract | fake Chrome/Android/gateway tests asserting messages, endpoints, auth, bounded evidence, proposals and receipts | Transport or boundary consolidation |
| T3: hermetic integration | deterministic fake gateway + fake clock/audio/mic; full turn trace from input through visible terminal state | Every voice/turn/agent lifecycle reduction |
| T4: isolated runtime capture | Chrome-for-Testing DOM/accessibility snapshots, screenshots and event traces; Android emulator screenshots, logcat and frame/memory samples | UI/CSS/gesture/permission changes; no active user profile or device |
| T5: non-production end-to-end | preview gateway with separate state plus disposable browser profile/emulator; canonical typed, voice, stop, revoke, recovery, approval and OTA-discovery journeys | Before promotion of cross-process changes |
| T6: guarded canary | opt-in stable build with rollback, no active turn, state compatibility, and telemetry comparison | Only after T0-T5; required before deleting a compatibility path based on runtime usage |

Required semantic scorecard: identical accepted input traces; identical terminal outcome and user-visible state; no extra device/browser authority; no regression in p95 input-to-feedback and turn completion; no increase in peak heap, audio sources, timers, sockets, offscreen documents, polling requests, or dropped/replayed turns. Tests may grow without penalty.

## Ordered reduction portfolio

Savings are production estimates, not commitments. Each item must report measured before/after nonblank production LOC and tests separately.

### P0 — establish captures before large deletion (0 production LOC target)

- **Files/interfaces:** add test-only trace harnesses around browser `chrome.runtime` messages and `AgeeUiSpecRuntime`; Android gesture resolver, streaming callback and overlay state transitions. Define canonical traces for typed turn, describe, voice start/audio/commit/done, stop, cross-tab revoke, socket recovery, permission denial, action proposal/approval/receipt, and quiet cancellation.
- **Risk:** tests can accidentally encode implementation rather than behavior.
- **Proof:** T0-T3 for all traces; T4 baseline DOM/accessibility screenshots and emulator screenshots; timer/socket/audio-source resource baselines.
- **Performance:** harness must use fake clocks and not add production instrumentation.
- **Confidence:** high. This is the prerequisite for adversarial deletion.

### P1 — remove content-script sanitizer and stop-intent copies (180-260 LOC)

- **Files/interfaces:** `extension/content.js`, `extension/ui-spec-runtime.js`, `extension/stop-intent.js`, `extension/manifest.json`. Use `globalThis.AgeeUiSpecRuntime.sanitize`; expose a frozen classic-script `AgeeStopIntent.isStopCommand` or extend the already ordered shared-runtime pattern.
- **Behavior risk:** load-order/reinjection behavior and classic-script global collisions.
- **Proof:** T0 manifest ordering, T1 adversarial sanitizer/matcher corpus, T3 reinjection and stop-during-setup traces, T4 Chrome-for-Testing root-count/runtime-error capture.
- **Performance:** fewer parser functions/closures per injected page and less parse/compile work; no new messages.
- **Confidence:** very high.

### P2 — centralize browser authenticated gateway access (250-450 LOC)

- **Files/interfaces:** `extension/options.js`, `extension/background.js`, `extension/config.js`; runtime messages/ports for health, enrollment validation, profile/catalog/companion reads and writes. Background remains the sole token-bearing fetch adapter; options renders results only.
- **Behavior risk:** options must remain usable when the service worker wakes/restarts; error text and cache refresh could drift.
- **Proof:** T1 error/status mapping, T2 route/method/header/cache contracts, T3 worker-restart and unauthorized/unreachable cases, T4 options accessibility/screenshot states.
- **Performance:** fewer duplicate config/cache paths; potential extra extension message hop is negligible but measure options interaction latency.
- **Confidence:** high.

### P3 — one browser voice/turn state core for overlay and side panel (450-750 LOC)

- **Files/interfaces:** new or existing shared classic/module runtime used by `content.js` and `sidepanel.js`; move transcript merge, terminal-state guard, watchdog, recovery, session close, PCM queue ownership, and stop/revoke semantics out of both views. `background.js` port/message contract remains stable.
- **Behavior risk:** autoplay rules differ between content scripts and extension pages; side-panel persistence differs across tab navigation.
- **Proof:** T1 reducer traces with fake clock, T2 message contract, T3 socket close/error/recovery and cross-tab revoke, T4 both DOMs plus audio-source/timer leak capture, T5 preview voice journey.
- **Performance:** one transition model should reduce timers and leaked audio sources; ensure it does not create duplicate listeners or ship a large abstraction twice.
- **Confidence:** medium-high.

### P4 — choose one browser command surface; delete the other lifecycle (500-850 LOC)

- **Files/interfaces:** product decision across `extension/sidepanel.js`, `sidepanel.html`, `manifest.json`, relevant CSS and background panel port handlers. Recommended default: retain the specified in-page one-current-intent surface and remove the side-panel multi-turn implementation unless runtime captures prove unique usage/accessibility value.
- **Behavior risk:** chrome:// and pages where content scripts cannot run currently need an extension-owned surface; accessibility or tab-persistence may depend on the panel.
- **Proof:** T4 usage-capability matrix including restricted pages and keyboard-only access; T5 all canonical turn journeys; canary telemetry before removal.
- **Performance:** removes a second renderer, port, watchdog and audio graph when panel is used.
- **Confidence:** medium; large payoff requires explicit product evidence.

### P5 — graduate one gesture grammar on browser and Android (350-650 LOC)

- **Files/interfaces:** browser `content.js`, `options.js`, `options.html`, CSS/state hints; Android `MoaOrbTouchListener.java`, `MoaVoiceFirstTapResolver.java`, `OverlayService.java`, `MainActivity.java`, `MoaPrefs.java`; architecture/OpenSpec gesture contract.
- **Behavior risk:** highest interaction risk: muscle memory, drag-vs-hold timing, accessibility, silent tap, fresh thread and PTT commit.
- **Proof:** T1 exhaustive timestamp/pointer trace tables on both platforms, T3 voice lifecycle for each resolved action, T4 high-frame-rate pointer/event capture and emulator gesture replay, T6 opt-in canary usage/error evidence before legacy deletion.
- **Performance:** fewer timers, branches and delayed click resolutions; measure input-to-visible-feedback and accidental capture rate.
- **Confidence:** medium. Do not implement until the canonical grammar is selected from captures.

### P6 — make the Android overlay genuinely thin (450-900 LOC)

- **Files/interfaces:** `OverlayService.java`, `MainActivity.java`, possibly intents that open/focus full-app sections. Remove overlay-owned deep status, history/agent-run detail and settings-adjacent rendering; preserve orb, one-current-intent feedback, essential approval and action receipts. Full app remains the detailed control center.
- **Behavior risk:** users may currently rely on the overlay to see long-running run completion without opening the app; approvals must remain device-owned and immediately reachable.
- **Proof:** T1 surface-state policy, T2 navigation/intent contracts, T3 active-run completion and approval flows, T4 overlay window-count/size/accessibility/screenshot captures, T5 emulator journeys.
- **Performance:** fewer overlay views, polling/render work and window updates; measure service RSS, UI thread frame time and idle requests.
- **Confidence:** medium-high because the repository contract explicitly supports this boundary.

### P7 — collapse Android voice orchestration onto one state model (500-900 LOC)

- **Files/interfaces:** `OverlayService.java`, `MoaStreamingVoiceSessionController.java`, `MoaVoiceGatewaySocket.java`, `MoaAudioCaptureController.java`, `MoaAudioPlaybackController.java`, `MoaVoiceController.java`, `MoaVoiceSamplePlayer.java`. Controllers should expose one event/state contract; the service renders it and does not duplicate watchdog/terminal/fallback decisions.
- **Behavior risk:** concurrency, late callbacks, warm-mic handoff, silence commit, fallback speech and recovery are failure-prone.
- **Proof:** T1 reducer/model tests for every callback interleaving, T2 socket/audio adapters, T3 fake socket and fake clock traces including stale callbacks, T4 emulator mic/audio/logcat/resource capture, T5 preview gateway voice.
- **Performance:** expected fewer handlers/watchdogs and less duplicate buffering; assert one capture, one socket and bounded playback queue per active session.
- **Confidence:** medium-high after P0.

### P8 — retire unobserved Android compatibility voice legs (300-750 LOC)

- **Files/interfaces:** candidate `MoaVoiceController.java` platform recognizer path and/or local TTS fallback portions of `OverlayService.java`; final files depend on runtime usage. Keep gateway streaming as primary and retain only a product-approved degraded behavior.
- **Behavior risk:** offline/degraded use, devices lacking a compatible streaming route, and accessibility expectations.
- **Proof:** T4/T6 capability and usage captures by Android/API version, explicit degraded-network acceptance contract, preview outage tests, rollback artifact. Compilation alone is insufficient.
- **Performance:** can remove recognizer/TTS allocations and lifecycle conflicts; may worsen availability, so compare success rate as well as resource use.
- **Confidence:** low-medium until canary evidence exists.

### P9 — consolidate overlay visual primitives (250-500 LOC)

- **Files/interfaces:** `extension/overlay.css`, hand-built DOM in `content.js`, declarative UI component class mapping. Define shared card/status/control/token primitives and remove selector/state aliases only when captures show equivalence.
- **Behavior risk:** responsive position, high-contrast/focus states, host-page CSS isolation, animation timing.
- **Proof:** T0 selector/class reachability, T4 screenshot and computed-style matrices across viewport/zoom/themes plus accessibility tree, performance capture of style recalculation.
- **Performance:** smaller stylesheet and fewer selectors; avoid expensive descendant selectors and preserve shadow/root isolation assumptions.
- **Confidence:** medium-high.

## Expected program outcome

P1-P3 and P6-P7 are architecture-preserving consolidation with an estimated **1,830-3,260 production LOC** reduction. Product-supported deletions P4-P5/P8-P9 can raise the client reduction to approximately **3,230-6,010 production LOC** (13-26% of current client nonblank LOC). Those larger numbers are only credible after runtime captures select a canonical surface, gesture grammar, and fallback policy.

No candidate should be accepted because the tests merely pass. Acceptance requires: production LOC decreases, tests/evidence may increase, behavior traces remain equivalent, the trust boundary remains unchanged, and measured latency/resource use is equal or better.

## Audit verification evidence

- `browser_extension: npm run verify` passed, including seven voice-sampler lifecycle tests.
- `browser_extension: npm run smoke:ui-spec` passed the pure UI-spec runtime test and UI-spec smoke, then failed because `smoke-ui-spec-runtime.mjs` could not start/reach its expected local gateway. This is an environment/integration-gate blocker, not evidence of a product failure; no live gateway was contacted or changed.
- `android_app: ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest assembleDebug` passed (`BUILD SUCCESSFUL`, 38 tasks).
- No browser reload, Android install, device inspection, deployment, service restart, or sensitive-content access occurred.
