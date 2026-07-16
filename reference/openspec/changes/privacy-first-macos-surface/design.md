# Design

## Authority boundary

`MoaMac.app` owns Accessibility trust, observation grants, AX capture, local
redaction, payload preview, the capability manifest, approval UI, semantic AX
execution, and the canonical local receipt chain. The gateway/Aggie layer owns
sessions, reasoning, memory, runs, and proposals. It never receives an AX object
or directly executes a Mac action. Screen content and model output are hostile
evidence, never instructions.

V1 uses one stable Developer-ID-signed, hardened main application for AX. Apple
documents assistive Accessibility API use as incompatible with App Sandbox, so
direct notarized distribution is expected. Do not add an AX helper or depend on
same-identifier TCC attribution. A future uniquely identified sandboxed XPC
service may isolate networking only; it gets no protected-device authority and
sees only an already previewed/redacted body.

## Permissions and product grant

- Accessibility is requested only from **Enable Mac control**.
- Screen Recording is a separate optional capability requested only from
  **Attach focused-window screenshot**. Input Monitoring, Apple Events, and
  login item/LaunchAgent authority are absent. The unsandboxed app has no macOS
  network permission gate, so it ships no updater, analytics, vendor endpoint,
  or request outside an active release grant.
- Microphone belongs to a separate explicit voice flow.
- OS Accessibility trust is capability, not consent to observe, upload, or act.

Product grant:

```text
grant_id
bundle_id
local_pid / process_generation
verified_signing_identity
purpose
mode: single_snapshot | proactive_15m
allowed_fields
issued_at / expires_at
network_release: local_only | ask_each_time | trusted_server_15m
include_screenshot: Bool
destination_origin
```

It is memory-only, limited to one verified application process and at most 15
minutes, and always shows scope plus Pause/Stop. The PID/process generation and
verified signing identity remain local and are checked on every AX event/action.
Expiry, scope change, process exit/replacement/PID reuse/signature mismatch,
screen lock, sleep, permission loss, app restart, or dismissal revokes it.
Observe/dismiss sends no network request.

## AX observation, focused-window capture, and redaction

Use scoped `AXObserver` notifications instead of screenshot timers or whole-
desktop polling. A snapshot is limited to 128 nodes, depth 8, 256 characters per
label, 16 KiB outbound JSON, and a 30-second element/snapshot lifetime. Local AX
references, PIDs, coordinates, and frames never leave process memory.

Snapshot nodes contain a random local id/parent id, normalized role/subrole,
bounded label, enabled/focused state, and supported semantic actions. Always
drop secure-text subtrees and editable values by default. Redact credential and
token patterns, payment identifiers, email/phone identifiers, URL path/query/
fragment, and home-directory identity. Hard-suppress authentication,
password-manager, payment, and security-settings windows with no v1 override.

Screen capture is independent of AX observation and off by default. During an
active grant the user may enable focused-window capture for the same verified
process. Use public ScreenCaptureKit to capture only the matched foreground
window, revalidate the window/PID/bundle before and after capture, scale the
longest edge to at most 1280 pixels, strip metadata by re-encoding JPEG, and cap
the encoded image at 1 MiB. Never capture the whole desktop or use a screenshot
timer outside the visible grant.

## Release preview

Ask-each-time mode shows the exact canonical HTTPS URL including path,
HTTP method, selected headers/content type, redirect policy, exact redacted JSON
values, redacted/dropped/truncated counts, operational session/device ids,
optional image presence/byte count/digest, retention statement, and explicit
exclusions. Serialize the immutable request buffer once and bind approval to its
SHA-256 digest plus method, full URL, selected headers, and `redirect: error`.
Any change invalidates approval; redirects are rejected rather than followed.

Trusted-server mode requires a separate confirmation that names the canonical
user-configured origin, included evidence classes, screenshot state, and expiry.
It may release event-driven snapshots without per-card confirmation only while
that visible grant remains valid. Stop, expiry, destination/configuration
change, app identity change, sleep/lock, or permission loss cancels queued work
before another request. There is no packaged destination or third-party route.

## Semantic action broker

Initial operations are `press`, `confirm`, `cancel`, `increment`, `decrement`,
`show_menu`, `pick`, and `set_value` only for a currently non-secure, settable
element. Every model-originated action requires confirmation in v1 and binds the
session, surface, proposal/message ids and digest, snapshot/state digest,
app/window/element fingerprints, local capability manifest, and a <=30-second
expiry. Proposal ids/nonces are one-shot and atomically consumed before the AX
mutation; any duplicate or replay is rejected even inside the validity window.

Execute only `AXUIElementPerformAction` or narrowly validated
`AXUIElementSetAttributeValue`. V1 has no coordinate click, synthesized mouse or
keyboard event, focus steal/window raise, AppleScript, shell GUI automation, or
private API fallback.

Atomically and durably commit/fsync a pending local receipt before execution; if
durability fails, do not execute. Write the terminal receipt directly afterward.
Store hashes and bounded outcomes, not raw labels, values, AX trees, or
screenshots. Each record includes the previous-receipt hash, forming a
hash-linked sequence only—not independent tamper evidence, attestation, or a
cryptographic identity claim. Optional gateway sync is default-off, must be
disclosed and bound into the action approval, and occurs only after the terminal
local record exists.

### Bounded surface-program execution

During a separately enabled, visible network grant, MoaMac may advertise the
`macos.javascriptcore-ax.v1` profile and receive one canonical proposal at a
time. The program runs in a killable helper process and sees only frozen
Promise-returning semantic tools plus bounded cancellation, progress, and result
channels. The raw JavaScriptCore host object, AppKit, ApplicationServices,
filesystem, process, network, Apple Events, JXA, and shell facilities are not
part of the generated-code realm. Source declares and the helper invokes the
literal `main` entrypoint advertised by the profile.

The application owns proposal validation, exact target revalidation, approval,
pending-effect durability, Accessibility calls, post-state proof, receipt
chaining, cancellation, and gateway synchronization. Invalid but identifiable
proposals receive a durable sequence-1 rejection. Gateway delivery preserves
local journal order: a tool receipt precedes its `tool_finished` event and the
terminal receipt precedes the terminal event. Pausing or stopping revokes the
client and helper before another claim.

The low-level public Accessibility C API is isolated behind a typed injected
seam. Synthetic element graphs cover the substantive traversal, binding, action,
and error-normalization adapter without reading a live application or changing
TCC. The raw C translation shell owns no proposal, approval, receipt, or success
policy.

Swift's LLVM coverage output for this package exposes regions, lines, and
functions but reports no branch counter. Therefore the executable-policy gate
uses LLVM regions as the branch proxy and requires more than 90% regions, lines,
and functions for each substantive runtime module. Only the minimal raw C API
translation shell is reported separately; it is never exercised against the
user's live Accessibility state during automated QA. Source-discovery tests
ensure executable policy cannot migrate into that shell unnoticed.

## Aggie and portability

Read-only context uses the canonical Aggie turn context once that facade lands.
Native actions require an explicit protocol extension for semantic `ui.*`
proposal kinds; they must not be hidden in browser tasks, generic context, or
ignored additive fields.

Portable: grants, preview/redaction report, semantic node/digest model,
proposal/approval/receipt envelopes, action vocabulary, and risk classes.
Adapters remain distinct: macOS AXUIElement, Windows UI Automation, existing
Android AccessibilityNodeInfo broker, browser DOM/CDP broker, and iOS own-app UI
plus App Intents/Shortcuts. iOS must not advertise arbitrary cross-app control.

## Prohibited inheritance from Clicky

Do not copy vendor routes/credentials, proprietary prompts/assets, background
activity-timeline persistence, PostHog/Sentry telemetry, Sparkle auto-update
behavior, private SkyLight/SLS/SLPS symbols, same-ID helper strategy, unscoped
desktop screenshot polling, or closed binary implementation. Narrow mechanisms
from MIT-licensed OpenClicky may be clean-room adapted with attribution.
