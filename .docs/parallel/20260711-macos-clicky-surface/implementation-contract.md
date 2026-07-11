# macOS Surface Implementation Contract

## Trust model

The capability is intentionally Clicky-like; the trust boundary is not. The
user owns the configured Aggie gateway and explicitly chooses whether context is
local, approved per release, or released continuously for a bounded grant.
macOS Accessibility or Screen Recording permission alone never starts capture
or networking.

## Native files

- Extend `apple_surfaces/Package.swift` with `MoaMacCore`, `MoaMac`, and focused
  tests while preserving the portable `AggieAppleSurface` library.
- `MoaMacCore` owns value types, grants, bounds/redaction, immutable request
  previews, destination policy, suggestion coordination, and injectable
  protocols for AX/capture/network/clock.
- `MoaMac` owns AppKit/SwiftUI, explicit permission buttons, AX observation,
  focused-window ScreenCaptureKit capture, settings/Keychain, status UI, and
  public AX semantic execution.
- A deterministic packaging script creates a stable unsigned QA bundle without
  launching it. Signing/notarization is a later promotion gate.

## Grant

```text
id, bundle_id, pid, process_start, signing_identity
mode: local_only | ask_each_time | trusted_server_15m
include_screenshot: Bool
issued_at, expires_at (<= 15 minutes)
destination_origin (required for network modes)
```

Stop, expiry, restart, sleep/lock, AX trust loss, process exit/replacement, PID
reuse, signing mismatch, bundle/app switch, or capture mismatch revokes the
grant and invalidates queued work.

## Observation

- Event-driven `AXObserver` scoped to the granted PID, with a low-rate fallback
  only during an active visible grant.
- Maximum 128 nodes, depth 8, 256 UTF-8 bytes per label, and 16 KiB AX JSON.
- Include roles/subroles, bounded labels, enabled/focused state, and supported
  semantic actions. Drop secure-text subtrees and editable values.
- Optional focused-window JPEG uses `SCShareableContent` plus
  `SCScreenshotManager`, max dimension 1280 and max encoded size 1 MiB. Recheck
  PID/window/bundle before and after capture.

## Gateway request

`POST /v1/proactive/macos` uses exact bounded JSON:

```json
{
  "version": 1,
  "client": { "surface": "macos", "release_mode": "ask_each_time" },
  "observation": {
    "observation_id": "opaque-id",
    "captured_at": "ISO-8601",
    "app": { "bundle_id": "com.example", "name": "Example" },
    "window": { "title": "bounded title" },
    "ax": { "nodes": [], "truncated": false, "dropped": 0 },
    "screenshot": null
  }
}
```

When present, screenshot is an exact JPEG base64 value plus SHA-256 and pixel
dimensions. The client serializes one immutable body, shows/hash-binds it in ask
mode, uses an ephemeral no-redirect session, and sends those exact bytes only.
The server requires bearer authentication, uses a no-tools provider call,
persists no observation/conversation/run/task/broker state, and returns exactly
`{"version":1,"suggestion":"…","actions":[]}`. Suggestion text is nonempty
and at most 2,048 UTF-8 bytes; unknown fields, versions, and nonempty actions
fail closed in both server tests and the native decoder.

## Actions

Extend the closed Aggie action vocabulary with explicit `ui.press`,
`ui.confirm`, `ui.cancel`, `ui.increment`, `ui.decrement`, `ui.show_menu`,
`ui.pick`, and `ui.set_value`. Resolve a short-lived local element fingerprint,
recheck process/window/state/security, then use only
`AXUIElementPerformAction` or a validated settable value. Every proposal goes
through `AppleActionCoordinator` and local approval; replay/stale/scope failures
never mutate UI. The current candidate compiles and tests this authority seam
but intentionally does not expose live native mutation until proposal ingestion,
element/state fingerprinting, and fsync-backed pending/terminal receipts exist.

## Public-source provenance

OpenClicky is MIT licensed (copyright 2026 Jason Kneen). Narrow focused-window
capture and permission patterns may inform or be clean-room adapted. Any
substantially derived code retains the MIT text in `THIRD_PARTY_NOTICES.md`.
No closed installed-binary implementation is copied.

## Quality gates

- Tests use fake clock/workspace/AX/capture/network implementations and prove
  startup silence, grant revocation, bounds/redaction, screenshot opt-in,
  immutable-body equality, redirect refusal, destination restriction, inert
  suggestions, and one-shot semantic actions.
- Static scan rejects `SkyLight`, `SLEvent`, `dlopen`, AppleScript, shell UI
  automation, coordinate clicks, passive analytics, and packaged destinations.
- Real TCC QA is manual and isolated; this implementation turn does not launch
  the bundle or request permissions.
