## ADDED Requirements

### Requirement: Phone entrypoints share visible-label app tools
The gateway SHALL expose the same bounded `app.launch` and `app.list` proposal
schema to Android ordinary typed chat, HTTP voice turns, cascaded voice
reasoning, and legacy-Live tool dispatch, and Android SHALL retain launcher
resolution and execution authority.

#### Scenario: Unique visible launcher label
- **WHEN** the current user turn explicitly asks to open a visible app label
- **AND** exactly one exported launcher activity matches that label
- **THEN** the gateway pins an `app.launch` proposal to the source Android device
- **AND** Android launches that exact activity and writes a claim-bound receipt

#### Scenario: List visible apps
- **WHEN** the current user turn explicitly asks which apps are installed
- **THEN** Android returns a count- and text-bounded list of visible launcher labels
- **AND** no package, component, activity, or hidden application id is disclosed
  as execution authority

#### Scenario: Raw selector or ambiguous label
- **WHEN** a proposal supplies a package/component/activity/intent selector or a
  visible label resolves to zero or multiple launcher activities
- **THEN** Android performs no launch and returns a terminal failure receipt

### Requirement: Android owns local media execution
The gateway SHALL treat media output as an inert proposal, and Android SHALL
validate, execute, and receipt supported local media tools.

#### Scenario: Launch a visible installed app
- **WHEN** the user asks to open an app with one unique launcher match
- **THEN** Android opens that launcher activity and records a local receipt
- **AND** an ambiguous or hidden component match executes nothing

#### Scenario: Notification access is absent
- **WHEN** a media request needs active-session metadata or transport control
- **AND** the user has not granted Notification access
- **THEN** Android returns a needs-permission result and performs no media action

#### Scenario: Guarded seek
- **WHEN** the active session advertises seek and still matches the proposal's
  package and media fingerprint
- **THEN** Android clamps and applies the requested position and receipts it
- **AND** stale identity or unsupported seek performs no action

### Requirement: YouTube search and opening remain device-local
Android SHALL open validated YouTube media through installed-app intents,
MediaSession transport, or a bounded package-specific Accessibility adapter.

#### Scenario: Preferred app alias or explicit override
- **WHEN** more than one installed app can handle canonical YouTube media
- **THEN** the local `YouTube` alias selects the installed Advanced/ReVanced app
  by default
- **AND** an explicit user-visible `Advanced`/`ReVanced` or `stock`/`official`
  name may select that compatible installed app for one request
- **AND** model output alone cannot select or persist a package override

#### Scenario: Undocumented adapter drifts
- **WHEN** an app-specific adapter's package signature, supported version, or
  expected bounded UI state does not match
- **THEN** Android disables that adapter for the request, executes nothing, and
  returns a fail-closed receipt

#### Scenario: Exact media URI
- **WHEN** a request contains a valid YouTube video id or HTTPS watch URI
- **THEN** Android opens the canonical video at the optional bounded timestamp

#### Scenario: Search title is unique
- **WHEN** a bounded search or visible result uniquely matches title/channel evidence
- **THEN** Android starts that result and receipts the observed media identity
- **AND** ambiguity executes nothing

### Requirement: Saved spots require real video identity and support bounded sync
Android and the browser extension SHALL admit a saved spot only with a valid
real YouTube video id, SHALL keep an app-private local record, and SHALL sync a
bounded record through the gateway only after explicit user approval.

#### Scenario: Remember and reopen a valid spot across surfaces
- **WHEN** Android resolves a valid video id and position and the user names and
  approves the spot
- **THEN** Android stores and syncs the bounded bookmark record
- **AND** the browser extension can later resolve its label and open the same
  video id near the saved position

#### Scenario: Weak or title-only identity
- **WHEN** only title/package identity is available
- **THEN** the surface refuses bookmark creation and sync
- **AND** may use that evidence only for a transient, explicitly confirmed search

#### Scenario: Bookmark sync disclosure
- **WHEN** a surface proposes syncing a saved spot
- **THEN** the approval names the video id, timestamp, label, and optional bounded
  note/title that will leave the device
- **AND** no cookie, credential, page body, accessibility tree, media-session
  token, raw audio, or unrestricted URL is included

#### Scenario: Natural text recall
- **WHEN** the user recalls a spot by its transcribed name or description
- **THEN** the surface ranks exact label, phrase containment, then bounded
  normalized-token overlap over approved textual fields
- **AND** equal best matches are reported as ambiguous
- **AND** raw-audio fingerprint matching is not performed

### Requirement: Local effects converge through durable claim-bound records
Android and the browser extension SHALL durably separate local execution from
gateway receipt and bookmark synchronization, SHALL suppress duplicate effects
after restart, and SHALL fail closed when bounded durable capacity is full.

#### Scenario: Terminal tool receipt is retried
- **WHEN** a surface executes a claimed request but delivery of its terminal
  receipt is interrupted
- **THEN** it retains the request id, claim id, one receipt id, and canonical
  result in local durable state
- **AND** it retries the same receipt without repeating the local effect
- **AND** the gateway accepts it only for the current claimant before lease
  expiry and treats an identical terminal retry as idempotent

#### Scenario: Bookmark delete is interrupted
- **WHEN** a user-approved bookmark delete cannot be acknowledged by the gateway
- **THEN** the surface commits a delete tombstone before removing the local record
- **AND** suppresses a matching stale gateway record until remote deletion is
  acknowledged
- **AND** it never evicts another unacknowledged record to make space

### Requirement: Browser media parity uses canonical URLs
The browser extension SHALL parse, open, create, and recall YouTube saved spots
through canonical URLs and the shared bounded bookmark records without OAuth,
cookies, CDP, or an authenticated browser-agent session.

#### Scenario: Browser saves the current canonical video
- **WHEN** the user explicitly remembers a spot on a supported YouTube URL and a
  valid video id plus bounded current playback position are available
- **THEN** the extension stores and syncs the same bounded bookmark shape used by Android

#### Scenario: Browser URL is ambiguous or unsupported
- **WHEN** the current URL does not yield exactly one valid YouTube video id
- **THEN** the extension creates no bookmark and reports the unsupported identity

#### Scenario: Browser searches by title and channel
- **WHEN** the user explicitly asks the browser to search YouTube with a bounded
  query and exact target title plus an optional exact channel
- **THEN** the extension opens a local YouTube results page and selects only one
  result with the exact normalized title and channel evidence
- **AND** zero or duplicate matches execute nothing and request clarification

### Requirement: Playlist mutations require local approval
Android SHALL execute playlist mutations only through a fixed, package-bound UI
state machine after a request-bound local confirmation.

#### Scenario: Confirmed mutation
- **WHEN** the approval digest, package, expected UI state, and expiry still match
- **AND** the installed version code, signer digest, UI-profile version, active
  window, and any required media identity still match the approved evidence
- **THEN** Android performs one requested playlist mutation
- **AND** reports success only after a fresh bounded observation proves the exact
  membership, create, rename, or delete postcondition

#### Scenario: Drift or rejection
- **WHEN** approval is rejected/expired or package/UI state changes
- **THEN** Android performs no mutation and records the terminal result
