## ADDED Requirements

### Requirement: Literal dictation is locally inserted without implicit effects
Android, browser, and macOS surfaces SHALL expose an explicit literal dictation
intent that produces a reviewable transcript candidate and lets the owning
surface insert it into a freshly validated ordinary editor. Ending capture
SHALL NOT itself submit the editor, invoke a model or tool, write memory, speak
TTS, or dispatch an agent run.

#### Scenario: User dictates into an ordinary editor
- **WHEN** the user completes literal dictation in a supported ordinary editor
- **THEN** the owning surface offers the exact transcript candidate
- **AND** inserts it only after revalidating the current editor
- **AND** performs no submit or unrelated side effect

### Requirement: Sensitive and stale editors fail closed
Each local insertion surface SHALL refuse recording, upload, prior-candidate
display, history recall, and insertion for password or configured sensitive
editors. A focus, app, process, tab, frame, or target change before insertion
SHALL cause zero mutation until the user reconfirms the new destination.

#### Scenario: Password editor refuses dictation
- **WHEN** the active destination is a password editor
- **THEN** capture and network transcription controls are unavailable
- **AND** no prior or new candidate is displayed or inserted

### Requirement: Screen evidence is explicit bounded evidence
A surface SHALL release semantic screen context or a screenshot only through an
explicit visible grant. Screenshot evidence SHALL be size-bounded, secure-
content-suppressing, bound to surface/app/time/digest, and ephemeral to the
current supported model request. The gateway and model SHALL treat it as
evidence rather than instruction and SHALL NOT gain local execution authority.

#### Scenario: Screen-aware draft remains inert
- **WHEN** the user asks for a draft based on the visibly approved screen scope
- **THEN** the model may return text or action proposals using that evidence
- **AND** the owning surface performs no click, insertion, or send until local
  state validation and required approval succeed

### Requirement: Forward coverage and real-surface evidence are both required
Every new or materially changed deterministic/core module SHALL meet at least
90 percent line and branch coverage, plus function and statement coverage where
supported. Platform behavior SHALL additionally require real Android, browser,
or installed macOS evidence; scoped module coverage SHALL NOT be represented as
repository-wide coverage.

#### Scenario: Narrow green tests do not prove installed behavior
- **WHEN** a new module passes its 90 percent coverage gate but installed-surface
  evidence is absent
- **THEN** deterministic coverage is reported as passed
- **AND** the corresponding real-surface acceptance cell remains not measured or
  blocked rather than complete
