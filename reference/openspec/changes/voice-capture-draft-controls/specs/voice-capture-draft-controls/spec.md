## ADDED Requirements

### Requirement: Draft capture does not execute
The gateway SHALL keep `voice_draft` capture separate from a canonical voice
turn. Before explicit SEND, capture, pause, park, resume, and discard SHALL NOT
invoke a provider, model, tool, broker, memory writer, or canonical turn writer.

#### Scenario: Pause produces no answer
- **WHEN** the user moves left during a confirmed draft hold
- **THEN** microphone capture stops and the draft remains resumable
- **AND** no transcript, assistant response, tool call, or turn completion is
  generated

### Requirement: Park and resume survive restart
The gateway SHALL durably park bounded draft audio with revisioned metadata and
SHALL recover orphaned capturing/paused drafts as parked after restart.

#### Scenario: Resume after process restart
- **WHEN** the user parks a draft, the gateway restarts, and the user resumes it
- **THEN** new audio appends after the prior bytes in exact order
- **AND** SEND submits the assembled audio through one ordinary voice turn

### Requirement: Discard removes user content
Explicit discard and OS/browser capture cancellation SHALL close capture,
physically remove draft audio and partial transcript, and retain only a bounded
content-free receipt/tombstone.

#### Scenario: System cancellation never sends
- **WHEN** Android emits `ACTION_CANCEL` or the browser emits
  `pointercancel` during a confirmed hold
- **THEN** the client requests discard and never `commit_turn`
- **AND** no incomplete canonical turn or provider event is created

### Requirement: Directional controls are compatible
Under the voice-first flag, release SHALL send, left SHALL pause, up SHALL park,
and down SHALL discard after a dominant-axis threshold. Movement before the
hold threshold SHALL remain orb/mark drag, and flag-off behavior SHALL remain
unchanged.

#### Scenario: Ambiguous movement is inert
- **WHEN** displacement is below threshold or no axis is sufficiently dominant
- **THEN** no pause/park/discard action is selected
- **AND** release is the only action that may send

### Requirement: New-root and capability use fail closed
Draft controls SHALL only be enabled when the gateway advertises the complete
capability. Explicit new/fork/incognito admission failures SHALL NOT fall back
to a current or default thread.

#### Scenario: Older gateway
- **WHEN** a client connects to a gateway without `voice_drafts_v1`
- **THEN** pause/park controls are disabled and legacy voice remains available
- **AND** the client does not claim a draft was parked

### Requirement: Draft authority and terminal vocabulary are exact
Every draft protocol message SHALL bind exact authority and state. Starts,
ready events, controls, acknowledgements, SEND, and terminal receipts bind the
same session, branch, turn, draft ID, and positive integer revision. Successful
SEND SHALL terminate as `sent`; privacy deletion SHALL terminate as
`discarded`. Clients and the gateway SHALL NOT translate these states into
compatibility aliases such as `consumed`.

#### Scenario: Stale or cross-authority receipt
- **WHEN** a client receives a receipt with a missing or different session,
  branch, turn, draft ID, non-integer revision, or non-advancing revision
- **THEN** it rejects the receipt and retains its prior authoritative pointer
- **AND** it does not start capture, clear content, claim SEND success, or emit
  a follow-on control from the untrusted receipt
