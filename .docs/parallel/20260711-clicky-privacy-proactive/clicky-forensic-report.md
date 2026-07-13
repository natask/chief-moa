# Clicky 1.0.33 Privacy / Capability Forensic Report

Date: 2026-07-11
Scope: the user's installed `/Applications/Clicky.app`, retained local network
cache, application-support schema/aggregates, bundled code/signing metadata, and
public OpenClicky reference source. The app was not launched, stopped, modified,
or granted/revoked permissions during this audit. No `.env`, bearer token,
recorded context value, window title, site value, suggestion text, screenshot,
or transcript was printed into this report.

## Executive finding

Clicky's retained local evidence proves ambient accessibility/activity capture,
server-side proactive suggestion processing, and screenshot-bearing upload on a
separate chat-tool route. It does **not** prove periodic proactive screenshot
upload or the vendor's internal generation method.

Three retained POSTs target vendor-worker proactive routes. These are CFURL
cache-row timestamps, not authoritative server receipt times:

- 2026-07-06 11:54:24 UTC: `/proactive-agents`
- 2026-07-10 09:17:02 UTC: `/proactive-agents/resolution`
- 2026-07-11 03:31:19 UTC: `/proactive-buddy`

The decoded `/proactive-agents` request schema includes a 214-character
`accessibility_context` in this retained sample, `frontmost_app_name`, 30
`recent_activity` entries
whose fields include app name, site host, window title, timing/duration, plus
connected integrations and recent suggestions. `/proactive-buddy` contains the
same context categories with five recent-activity entries and recent buddy
lines. None of the three retained proactive request bodies contains a screenshot
or image field. A retained `/proactive-agents` response contains two suggestion
objects, establishing a contextual request/response relationship without
exposing their content or inferring how the server produced them.

A separate retained cache entry (`141`) is direct screenshot transaction
evidence: an authenticated 458,171-byte JSON `POST /chat-tool-call` to the same
vendor worker received HTTP 200 with archived server date 2026-06-19 05:36:53
UTC. Its `screenshots` array has two populated base64 values that decode in
memory as 87,238-byte and 157,142-byte JPEGs; `screenshotBase64` duplicates the
first image. No encoded value or image pixel was printed or persisted by the
audit. App/helper code independently imports ScreenCaptureKit, JPEG/image
handling, and an AX-plus-screenshot computer-use mode.

The accurate conclusion is:

> Clicky records detailed foreground app/site/window/accessibility context and
> uploads it to proactive suggestion endpoints. The retained proactive samples
> were text/metadata requests, not screenshot requests. A retained
> `/chat-tool-call` proves that two screenshots were uploaded on another route.
> Periodic proactive screenshot upload, the trigger for that chat transaction,
> and informed consent were not established by the retained cache.

## Installed artifact

- Bundle: `com.humansongs.clicky`
- Display/executable: Clicky / `HeyClicky`
- Version/build: 1.0.33 (42)
- Embedded source commit: `2449ba5c`
- Developer Team: `2UDAY4J48G` (Farzain Majeed)
- Notarized, hardened runtime, not App-Sandboxed
- `LSUIElement=true`, so it can run without a normal Dock presence
- Bundled helper: `Contents/Helpers/ClickyComputerUseRuntime`, signed by the
  same team and identifier family

An earlier login/background-registry snapshot reported Clicky as
enabled/allowed/notified; the later independent recheck did not reproduce that
record. No Clicky process, live socket, active `launchctl` label, or standalone
LaunchAgent was present at either inspection moment. The retained evidence does
not establish continuous background execution.

The installed commit is not resolvable in the public `farzaa/clicky` history;
that repository explicitly says newer development moved private. The public
source is mechanism reference, not an exact source match for 1.0.33.

## Local activity store

`$HOME/Library/Application Support/Clicky/activity-timeline.sqlite` stores
plaintext rows with app bundle/name, window title, site host, context summary,
and deep accessibility context.

Read-only aggregate at audit time:

- 323 activity rows spanning July 6–11
- 314 rows with a window title
- 229 rows with a site host
- 213 rows with a context summary
- 189 rows with deep accessibility context
- 37,139 aggregate summary characters
- 1,562,609 aggregate deep-context characters
- largest observed deep-context length: 31,449 characters

Preferences structurally contain eight recent proactive suggestion records
(three approved, three denied, two expired) and one buddy-line record. Their
text/content was deliberately excluded.

## Network evidence method

The audit used SQLite read-only mode against
`$HOME/Library/Caches/com.humansongs.clicky/Cache.db`. CFNetwork archived request
objects were decoded locally as property lists; only JSON key names, value
types, array counts, nested key names, and string lengths were emitted. Header
values, authorization material, activity values, accessibility text, and
suggestion text were not emitted.

The cache is retained evidence, not a complete packet capture: it proves the
listed calls and payload schemas occurred, but cache-row timestamps can outlive
and differ from the currently archived request/response blobs. The archived
HTTP response dates for entries `161`, `180`, and `187` are respectively
2026-07-11 07:00:43, 2026-07-11 07:01:31, and 2026-07-11 03:31:19 GMT. Absence
from cache cannot prove a different call never occurred. A future controlled
packet capture should use a fresh macOS account/profile, a local TLS
interception proxy trusted only in that test profile, deterministic app actions,
and before/after network ledgers. It must not run against the user's live
working account.

## Accessibility and computer-use mechanisms

The installed product is native Swift/AppKit, not an AppleScript application.
Linked imports/symbols and embedded helper documentation support these
mechanisms:

- `AXUIElement` tree reads, observers, actions, and value mutation
- `CGEventPostToPid` for process-targeted input
- ScreenCaptureKit for screen/window pixels on screenshot-capable paths
- browser CDP/WebKit/Apple Events paths
- local MCP/Unix-socket computer-use runtime
- an embedded/dynamically resolved private SkyLight `SLEventPostToPid` fallback
  described in helper strings/tool documentation; SkyLight is not directly
  linked and this name is not a linked undefined symbol

The transferable, supportable part is public AX observation/action plus explicit
local approval and receipts. Chief Moa should not copy private SkyLight calls,
the same-identifier helper/TCC-attribution strategy, vendor telemetry, or silent
login launch. Signing proves shared identity/team, not that this strategy
successfully bypasses or shortcuts a permission.

## OpenClicky comparison

The local reference checkout at `nanoclicky/upstream/openclicky`, revision
`623a57a77e7043e7c3bebfddf7e8063eca9df755`, is useful prior art but not Clicky
1.0.33's source. (The remote had advanced to
`d38498a659ce010d0b5a852331841deb36d140ac` during the audit.)
OpenClicky defaults Tutor Mode on; after an
idle threshold it can capture the focused window and send an image to the
selected model. It also polls selected accessibility text and can show parsed
next-action suggestions after an invoked agent reply. Scheduled discovery is
off by default. These behaviors explain possible implementation techniques but
cannot be used as transaction evidence for the installed commercial build.

The clean reference checkout was also assembled, not merely read: an unsigned
arm64 Debug build completed successfully with Xcode into
`/tmp/openclicky-audit-derived/Build/Products/Debug/OpenClicky.app` using
`CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`. The app was not launched,
installed over Clicky, or used for TCC/permission testing, and the source
checkout remained clean. This proves the public Swift/AppKit reference is
buildable on this machine; it does not make it the source of installed Clicky
1.0.33.

## Public disclosure mismatch

The vendor privacy page describes screenshots/voice captured locally in
response to push-to-talk and sent through its backend, which may cover the
screenshot-bearing chat-tool request. The retained proactive routes and
recent-activity/accessibility schema are not explained by that narrow
push-to-talk description, and the public page contains no proactive/ambient
disclosure found during this audit. The product UI may contain additional
disclosure, but the observed proactive data boundary should be considered
untrusted until the vendor documents it precisely and offers a verified off
switch.

References:

- [HeyClicky privacy policy](https://www.heyclicky.com/privacy)
- [Public historical Clicky source](https://github.com/farzaa/clicky)
- [OpenClicky reference source](https://github.com/jasonkneen/openclicky)

## Immediate containment (not performed)

1. Quit Clicky and disable it in **System Settings → General → Login Items**.
2. Revoke Clicky under **Privacy & Security → Accessibility**. This is the key
   control because retained proactive data is accessibility text/metadata.
3. Revoke Screen Recording and Microphone as defense in depth.
4. Block Clicky's outbound connections with a local application firewall if it
   must remain installed for offline research.
5. Confirm no `HeyClicky`/`ClickyComputerUseRuntime` process or socket remains.
6. Preserve a read-only copy/hash of the app, Cache.db, and timeline database
   before uninstalling if future vendor/accountability analysis matters.

Do not delete the application-support data until deciding whether retained
forensic evidence or privacy deletion is the higher priority.
