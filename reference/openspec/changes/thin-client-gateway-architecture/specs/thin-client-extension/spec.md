## ADDED Requirements

### Requirement: Extension is a thin client
The browser extension SHALL act as a thin client: it renders surfaces from
engine-served specs, captures text/voice input, and brokers page access for the
engine. It SHALL NOT hold API keys or subscriptions, and SHALL NOT be the unit
into which a user deploys customizations.

#### Scenario: No secrets in the browser
- **WHEN** the extension needs to make a model/API call
- **THEN** it calls its configured engine with a session token, and the API keys/subscriptions used for the call live on the engine, not in the extension

#### Scenario: Renders engine-served surfaces
- **WHEN** the engine serves an updated UI spec for the user
- **THEN** the extension renderer reflects it without repackaging or reinstalling the extension

### Requirement: Stable extension package
The extension package SHALL change rarely and SHALL NOT be the channel for
user-specific customization, consistent with MV3's ban on remotely-hosted
executable code in the privileged context.

#### Scenario: Customization does not repackage the extension
- **WHEN** a user customizes their UI or behavior
- **THEN** the change is delivered by the engine as data or sandboxed/opt-in script, and the installed extension package is unchanged

### Requirement: Browser page-agent activity has one active owner
The browser extension SHALL treat the active page-agent owner as a single tab at
a time for audible voice and browser-local task cues. Same-tab cue concurrency
MAY continue, but starting an agent or voice turn in another tab SHALL revoke
other-tab voice capture/playback and cancel other-tab browser-local task cues.

#### Scenario: New tab agent revokes old tab activity
- **WHEN** a user starts a browser agent or voice turn in tab B while tab A has active extension voice/audio or task cues
- **THEN** tab A stops microphone capture, queued assistant playback, and browser-local task cues before tab B becomes the active page-agent owner

### Requirement: Browser tabs are work lanes
Browser-facing Moa work surfaces SHALL prefer addressable browser tabs as work
lanes over nested in-app tab managers. The extension and gateway-served browser
surfaces SHALL keep their own UI small: command entry, status, and focused
inspection only. When a browser workflow needs separate project, session, or
task context, it SHALL expose that context through a stable URL or browser tab
rather than adding another internal tab strip.

#### Scenario: User separates project work
- **WHEN** the user wants to keep two browser-side projects or task contexts
  open at once
- **THEN** the browser surface can open each context in its own browser tab with
  a stable URL
- **AND** each tab retains the selected project or context without relying on a
  single global in-page selection

### Requirement: Explicit ambient frame cadence
The browser extension SHALL expose an explicit ambient start/stop loop that posts
page-context frame messages to the configured engine at a 200 ms target cadence.
The loop SHALL treat those frames as evidence intake only, not as direct model
execution.

#### Scenario: Ambient loop is running
- **WHEN** the content script starts ambient mode with the default interval
- **THEN** the background service worker posts repeated `POST /v1/voice/frames`
  messages carrying the stable session id and monotonically increasing sequence
  numbers at the 200 ms target cadence
- **AND** stopping ambient mode cancels the interval locally
