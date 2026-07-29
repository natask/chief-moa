## ADDED Requirements

### Requirement: Phrase assist is explicit, versioned, and default-off
The gateway SHALL enable live phrase assist only when a streaming voice session
explicitly requests supported version 1 with `enabled: true`. Missing, false,
or unsupported capability declarations SHALL leave phrase assist disabled.

#### Scenario: A normal voice session does not invoke phrase assist
- **WHEN** a client starts a voice session without an enabled version 1 phrase-assist declaration
- **THEN** the gateway reports phrase assist disabled
- **AND** a phrase-assist request performs no generation

### Requirement: Requests bind to the gateway transcript revision
The gateway SHALL use only its latest normalized provider transcript snapshot
for phrase generation. A client request SHALL identify the active turn, a
request ID, and the exact transcript revision; it SHALL NOT provide transcript
content for generation.

#### Scenario: A request names a stale revision
- **WHEN** the request revision does not equal the gateway's latest transcript revision
- **THEN** the gateway returns a content-free `stale` terminal event
- **AND** does not invoke the phrase generator

### Requirement: Phrase generation has no action or memory authority
The gateway SHALL generate phrase suggestions through a dedicated adapter that
receives only the current transcript snapshot, excludes saved profile and
conversation context, disables model tools and native search, and cannot commit
a turn, invoke a device or browser action, launch an agent run, play TTS, mutate
a profile, or append canonical conversation history.

#### Scenario: A suggestion succeeds during recording
- **WHEN** an enabled active recording requests a suggestion for the current revision
- **THEN** the gateway emits only a transient phrase suggestion for that request
- **AND** the voice turn remains recording
- **AND** no commit, tool, agent, profile, TTS, or canonical-history callback runs

### Requirement: Suggestions are short phrases
The gateway SHALL normalize every generated suggestion to one line containing
at most eight words and at most 64 Unicode characters. An empty or explicitly
uncertain result SHALL produce an `empty` terminal event instead of a suggestion.

#### Scenario: The model returns a long multiline answer
- **WHEN** the generation adapter returns more than eight words, more than 64 characters, or multiple lines
- **THEN** the gateway emits one normalized phrase within both limits

### Requirement: Stale and repeated work is suppressed
The gateway SHALL allow one in-flight phrase generation per turn, enforce a
cooldown between accepted generations, reject unchanged transcript snapshots,
and treat repeated request IDs idempotently. Transcript revision, explicit
client cancel, voice commit, voice cancellation, replacement, and connection
closure SHALL invalidate active generation before its result can be emitted.

#### Scenario: Speech resumes during generation
- **WHEN** a client cancels the active phrase request or a newer transcript revision arrives
- **THEN** the gateway aborts or invalidates that generation
- **AND** a late model completion cannot emit a suggestion

#### Scenario: A client retries the same request ID
- **WHEN** the gateway receives the same request ID more than once
- **THEN** it invokes the generator at most once for that request
- **AND** it may replay the same transient terminal receipt

### Requirement: Phrase-assist diagnostics are content-free
Phrase-assist diagnostics SHALL NOT include transcript text, suggestion text,
or a content-derived hash. They MAY include bounded identifiers, transcript
revision and character count, pause duration, elapsed duration, terminal
status, output character count, and a bounded error code.

#### Scenario: Operators inspect a failed phrase request
- **WHEN** a phrase request ends stale, canceled, empty, or error
- **THEN** diagnostics explain its lifecycle without exposing the transcript or suggestion
