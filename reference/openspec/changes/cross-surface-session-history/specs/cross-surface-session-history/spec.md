## ADDED Requirements

### Requirement: Canonical Mixed-Source Session Messages

The gateway SHALL expose one authenticated, ordered session-message projection
that combines retained Android and browser text/voice turns without making any
client-local store canonical.

#### Scenario: Android and browser messages share one projection

- **WHEN** one authorized session contains Android text, Android voice, browser
  text, and browser voice turns
- **THEN** the gateway returns each retained user and assistant message with a
  stable canonical message identity
- **AND** includes its session, branch, turn, source surface, source kind,
  speaker, timestamp, and completion state
- **AND** orders the messages deterministically

#### Scenario: Mirrored records do not duplicate a message

- **WHEN** one accepted turn is mirrored into turn, broker, work-history, or
  product-event storage
- **THEN** the projection emits one canonical user message for that turn
- **AND** does not merge a different message merely because its text is similar

#### Scenario: Incomplete or audio-only output remains honest

- **WHEN** a turn is canceled, incomplete, or has no retained assistant text
- **THEN** the projection returns the retained partial evidence and completion state
- **AND** does not fabricate an assistant transcript

### Requirement: Deterministic Latest-N History Reads

The canonical projection SHALL return a bounded latest-N session view in
deterministic order and report the applied bound and available completeness
metadata.

#### Scenario: Session contains more records than the requested bound

- **WHEN** an authorized client requests the latest N messages for a session
- **THEN** the gateway selects no more than the applied bounded limit
- **AND** returns the newest turn first
- **AND** returns the user message before the assistant message within each turn
- **AND** uses a deterministic canonical-identity tie-break for equal turn times
- **AND** reports the applied limit, returned count, available count when known,
  included source counts, and excluded or unreadable counts

#### Scenario: Unauthorized or private history is requested

- **WHEN** authentication, session ownership, branch scope, or requested bound is invalid
- **THEN** the gateway returns no message content
- **AND** no incognito or foreign-session record appears

### Requirement: Durable Browser Side-Panel Workspace

The browser extension SHALL use its extension-owned side panel as the durable
browser interaction workspace over canonical gateway messages.

#### Scenario: Side panel reopens after restart

- **WHEN** the user closes and reopens the side panel or the extension service
  worker restarts
- **THEN** the side panel reloads canonical session messages from the gateway
- **AND** renders each message once using canonical identity

#### Scenario: Side-panel history load fails

- **WHEN** the canonical history request is unreachable or unauthorized
- **THEN** the side panel shows a visible load error and retry action
- **AND** does not present the failure as a successful empty history

#### Scenario: Typed and voice turns remain inspectable

- **WHEN** the user completes one typed browser turn and one browser voice turn
- **THEN** the side panel shows the retained user text/transcript and assistant
  response or honest unavailable-text state for each
- **AND** preserves bounded linked work and receipt status when present

### Requirement: Transient Browser On-Page Overlay

The browser on-page overlay SHALL remain a current-turn surface and SHALL NOT
become a canonical scrollback store.

#### Scenario: Resolved cue retires

- **WHEN** a current browser cue reaches its configured terminal lifecycle
- **THEN** the overlay may retire that cue
- **AND** provides an explicit handoff to the durable side-panel workspace
- **AND** the canonical message remains available after content-script restart

### Requirement: Android Full-App Session History

The Android full app SHALL render the canonical mixed-source session projection
while the floating overlay remains compact.

#### Scenario: Android inspects cross-surface history

- **WHEN** the user opens session history in the full Android app
- **THEN** the app shows retained Android and browser messages with matching
  canonical identities, source kinds, completion states, and bounded work or
  receipt status

#### Scenario: Android overlay remains transient

- **WHEN** prior session history exists and the floating overlay opens
- **THEN** the overlay shows only current capture/result/status and approval UI
- **AND** prior scrollback remains in the full app

### Requirement: Platform Authority Remains Local

Reading session history SHALL NOT grant or expand local execution authority.

#### Scenario: Browser receipt appears in history

- **WHEN** a canonical message links to an existing browser-local action receipt
- **THEN** the workspace may display a bounded read-only receipt summary
- **AND** does not claim, repeat, or expand the browser action

#### Scenario: Phone receipt appears in history

- **WHEN** a canonical message links to an Android-local action receipt
- **THEN** the full app may display a bounded read-only receipt summary
- **AND** Android remains the authority for permission, approval, execution,
  and any future retry

### Requirement: Recording History Uses One Card Per Recording

The browser History view SHALL render one outer card or section per retained
recording in canonical newest-first order. Each card SHALL keep its user
transcript before its tied assistant response. Transcript revisions SHALL
remain inside their recording card.

#### Scenario: History contains three recordings

- **WHEN** History receives three retained voice turns in canonical newest-first
  order
- **THEN** it renders one outer card per recording in that order
- **AND** keeps each user transcript before its tied assistant response
- **AND** does not render transcript revisions as peer history cards

### Requirement: Every Retained User Transcript Can Be Copied

The browser History view SHALL expose an exact Copy action for every selectable
transcript version. Copy SHALL use the selected stored transcript and SHALL NOT
start speech-provider work.

#### Scenario: User copies an older transcript

- **WHEN** the user selects an older transcript version and activates Copy
- **THEN** the clipboard receives that selected version exactly
- **AND** excludes its label, timestamp, assistant response, and hidden metadata
- **AND** no transcription request starts

### Requirement: Transcript History Keeps Only Useful Default Content

The default browser transcript list SHALL center retained user transcripts and
their tied assistant responses. It SHALL NOT repeat page, provider, session,
agent, developer, or duplicate current-turn status blocks above or between
transcript cards. Current errors and actions MAY remain visible when they affect
the active history read or transcription.

#### Scenario: User opens populated History

- **WHEN** retained transcripts are available and no history error or
  re-transcription is active
- **THEN** the default list shows transcript cards and tied assistant responses
- **AND** omits repeated page, provider, session, agent, developer, and
  current-turn status blocks
- **AND** keeps linked run or receipt evidence available through a secondary
  detail view when present

### Requirement: Audio Re-Transcription Creates A Revision

Opening or copying retained history SHALL use a stored transcript version and
SHALL NOT re-run speech recognition. The browser MAY offer Re-transcribe only
when the canonical turn exposes accessible retained audio. Each explicit
request MAY start a new attempt. Every successful attempt SHALL append a labeled
revision linked to the same source turn and audio. It SHALL preserve the
original and every older revision.

#### Scenario: Retained audio is available

- **WHEN** the user explicitly activates Re-transcribe twice on a turn with
  accessible retained audio and both attempts succeed
- **THEN** the product runs two explicit speech-recognition attempts
- **AND** appends two labeled transcript revisions
- **AND** preserves the original and first revision after the second succeeds
- **AND** makes the second revision the default displayed version

#### Scenario: User reviews transcript revisions

- **WHEN** one recording has an original transcript and later successful
  re-transcriptions
- **THEN** its outer card uses an inward stacked-card treatment for the versions
- **AND** its revision selector presents the original then later revisions in
  chronological order
- **AND** selecting an older version shows and copies that version without
  changing the default latest version

#### Scenario: Retained audio is unavailable

- **WHEN** audio was not retained or is deleted, expired, or unauthorized
- **THEN** the original transcript remains visible and copyable
- **AND** the UI does not offer an enabled Re-transcribe action
- **AND** it does not imply that retained transcript display came from a new
  provider request

#### Scenario: Re-transcription fails

- **WHEN** an explicit audio re-transcription request fails
- **THEN** the original transcript and every completed revision remain visible
  and copyable
- **AND** the affected turn shows a retryable error

### Requirement: Extension Toolbar Opens The Workspace

The browser extension toolbar action SHALL open the side-panel workspace for
this unit. It SHALL NOT create a turn, start capture, or change the active
session. Existing double-tap and session gestures SHALL keep their behavior.
Transcript-history search SHALL remain a follow-on.

#### Scenario: User clicks the extension toolbar action

- **WHEN** the user clicks the browser extension toolbar action
- **THEN** the side-panel workspace opens
- **AND** no turn or recording starts
- **AND** the active session and existing gesture behavior remain unchanged
- **AND** this unit does not require a History search field
