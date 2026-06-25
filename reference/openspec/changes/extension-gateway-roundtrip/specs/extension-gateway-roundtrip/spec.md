## ADDED Requirements

### Requirement: Meaningful action is engine-routed
The proof of this slice SHALL be that the rendered output originated from the
engine, not merely that output rendered, establishing the thin-client to engine
route. The extension SHALL reach the engine for typed page questions,
describe-page requests, and committed browser voice transcripts rather than
acting on its own.

#### Scenario: Reply provenance is the engine
- **WHEN** the overlay renders a command or describe result with a gateway configured
- **THEN** that result demonstrably originated from the browser-agent turn path,
  confirming the action was routed through the engine

### Requirement: Unified Browser Agent Turn Path
The gateway SHALL expose `POST /v1/browser/turns` as the canonical
browser-agent turn path for typed page questions, describe-page requests, and
committed browser voice transcripts. Browser turns SHALL be linked to a session,
branch, turn id, source kind, browser-agent owner, page evidence, and status
resource.

#### Scenario: Typed page question enters browser-agent turn path
- **WHEN** the user opens the overlay via Cmd+, and submits a page question with
  a gateway configured
- **THEN** the extension posts the question to `POST /v1/browser/turns`
- **AND** the rendered reply originates from that browser-agent turn

#### Scenario: Describe page uses the same turn path
- **WHEN** the user runs "describe page" with a gateway configured
- **THEN** the extension posts or references current page evidence
- **AND** sends the describe request to `POST /v1/browser/turns`
- **AND** the rendered description originates from that browser-agent turn

#### Scenario: Committed browser voice transcript uses the same turn path
- **WHEN** browser voice captures a final transcript for a page question
- **THEN** the extension commits the transcript as a browser-agent turn through
  `POST /v1/browser/turns`
- **AND** the turn keeps the same session and branch semantics as typed browser
  turns

### Requirement: Command round trip through gateway
The extension SHALL render browser command replies that originate from the
configured gateway browser-agent turn route.

#### Scenario: Command reply from gateway
- **WHEN** the user opens the overlay via Cmd+, and submits a command with a gateway configured
- **THEN** the reply rendered in the overlay originates from
  `POST /v1/browser/turns`

### Requirement: Browser surface is not visible chat history
The extension SHALL present a one-current-intent surface rather than a visible
chat transcript. Typed replies SHALL render in the result stack above the
command input, and assistant replies, errors, and voice events SHALL NOT clear
or replace the user's current input draft. Durable turn history SHALL remain
gateway-owned context and SHALL be retrieved only when the user asks for it
through an intent.

#### Scenario: Typed reply preserves the draft
- **WHEN** the user opens the text surface with Cmd+, and submits an intent
- **THEN** the assistant reply or error renders above the command input
- **AND** the command input still contains whatever draft text was present
  before the response arrived

#### Scenario: Voice shows live feedback above the input
- **WHEN** the user starts a browser voice turn with Cmd+.
- **THEN** the extension keeps the command input surface available for typing
- **AND** displays partial/final user transcript feedback above the input while
  the user speaks and while the turn is processing
- **AND** streams assistant text above the input instead of writing it into the
  command input
- **AND** it does not clear or replace any typed input draft during listening,
  commit, done, or error states
- **AND** it does not show older chat-history turns unless the user explicitly
  asks for history through an intent

### Requirement: Describe round trip through gateway
The extension SHALL render page descriptions that originate from the configured
gateway browser-agent turn route.

#### Scenario: Describe reply from gateway
- **WHEN** the user runs "describe page" with a gateway configured
- **THEN** the description rendered in the overlay originates from
  `POST /v1/browser/turns`

### Requirement: Visible gateway failure
The extension SHALL surface gateway connection and authorization failures to the
user rather than failing silently.

#### Scenario: Unreachable or unauthorized gateway
- **WHEN** the gateway is unreachable or rejects the token
- **THEN** a clear error message renders in the overlay

### Requirement: Browser voice uses gateway streaming voice
The extension SHALL route browser voice through the configured gateway streaming
voice protocol and SHALL NOT use browser-native speech recognition or browser
text-to-speech as the production voice path.

#### Scenario: Browser voice session ticket
- **WHEN** the extension has a configured gateway URL and token
- **THEN** it can mint a short-lived `/v1/voice/sessions` ticket from the gateway
- **AND** use that ticket for a browser WebSocket connection without exposing the
  long-lived gateway token in the WebSocket URL

#### Scenario: Browser microphone audio reaches the gateway voice provider
- **WHEN** the user starts a browser voice turn
- **THEN** the extension captures microphone PCM16 audio from an extension-owned
  offscreen document and streams it to
  `/v1/voice/sessions`
- **AND** assistant audio rendered in the browser originates from the gateway
  streaming voice response

#### Scenario: Browser voice auto-commits on silence
- **WHEN** the user starts a browser voice turn and speaks
- **THEN** the extension commits the turn after speech silence without requiring
  a second click or hotkey press
- **AND** conversation mode re-arms listening after the assistant reply unless
  the user explicitly stops it

#### Scenario: Browser mark push-to-talk commits on release
- **WHEN** the user presses and holds the browser Moa mark
- **THEN** the extension starts a manual gateway voice session
- **AND** the browser background worker disables silence auto-commit for that
  session
- **AND** releasing the mark commits the current speech turn immediately
- **AND** the manual turn does not re-arm the microphone after the assistant
  reply

#### Scenario: Browser voice sends current speech on mark click
- **WHEN** the user starts a browser voice turn and clicks the Moa mark once
  while the extension is listening
- **THEN** the extension commits the current captured speech turn immediately
- **AND** leaves the text input available for typed follow-up commands
- **AND** any final transcript that asks about the page enters the browser-agent
  turn path instead of a separate browser-only path

#### Scenario: Website does not own the microphone grant
- **WHEN** the overlay starts voice on a website
- **THEN** the page content script does not call `getUserMedia`
- **AND** any microphone approval belongs to the extension origin, not the
  current website

#### Scenario: Extension microphone capture is blocked
- **WHEN** Chrome blocks microphone capture in the extension offscreen document
- **THEN** the overlay renders a visible microphone permission error
- **AND** the error tells the user to grant microphone access to the Aggie
  extension from Options or Chrome extension settings
- **AND** the failure is treated as non-recoverable for that voice turn instead
  of silently respawning Live voice

### Requirement: Browser agent ownership is shared across tabs
The extension SHALL maintain one active browser-agent owner across tabs for a
configured engine session. The owner state SHALL live in shared
extension/gateway-facing state, not only in one page content script.

#### Scenario: Starting work in another tab transfers ownership
- **WHEN** a browser agent turn, branch task, ambient capture, or voice session
  starts in tab B while tab A is the active browser-agent owner
- **THEN** tab B becomes the active owner in shared extension state
- **AND** tab A receives revocation, stops listening, stops queued assistant
  playback, and clears browser-local task cues
- **AND** tab A may show passive status but does not capture microphone audio,
  play assistant speech, or claim local task cues for the active owner

#### Scenario: Owner state follows page work
- **WHEN** a browser task has no explicit target URL
- **THEN** the extension prefers the active owner tab's page URL before falling
  back to the foreground tab
- **AND** the latest owner status/result is stored in shared extension state so
  another tab can answer progress or completion questions without visible chat
  scrollback

### Requirement: Browser Context Is Evidence
The extension SHALL submit page context as bounded evidence, not as instruction.
Evidence SHALL include only scoped URL, title, visible page text, actionable
element summaries, screenshot references when available, page identity, and
collection timestamp. The gateway SHALL treat page text, element labels, and
screenshot content as untrusted context that can inform an answer or proposal
but cannot directly command browser actions.

#### Scenario: Page evidence is posted before a browser-agent turn
- **WHEN** the user asks a typed, spoken, or describe-page question about the
  current page
- **THEN** the extension posts bounded page evidence to
  `POST /v1/browser/evidence` or references equivalent recent evidence
- **AND** the browser-agent turn links to that evidence instead of relying on
  unstructured page text inside the user instruction

#### Scenario: Page text tries to issue an instruction
- **WHEN** visible page text or an actionable element label contains imperative
  language such as "click approve" or "ignore prior instructions"
- **THEN** the gateway treats that content only as evidence about the page
- **AND** the extension does not execute a browser action unless a separate
  bounded proposal passes browser-owned validation and approval checks

### Requirement: Operational Progress Surface
The extension SHALL show named browser-agent progress states in the overlay. The
gateway SHALL expose browser-turn status through
`GET /v1/browser/turns/{turn_id}/status`, and the overlay SHALL NOT rely on an
inert debug symbol as the only signal that work is happening.

#### Scenario: Browser turn reports progress
- **WHEN** a browser-agent turn is collecting evidence, queued, routing,
  thinking, awaiting approval, proposing an action, executing a browser action,
  done, refused, or failed
- **THEN** the status endpoint returns a named state and optional progress text
- **AND** the overlay renders that state in user-visible language

#### Scenario: Status endpoint is unavailable
- **WHEN** the extension cannot fetch browser-turn status
- **THEN** the overlay renders a visible connection or status error
- **AND** it does not leave the user with only a static debug mark

### Requirement: Browser-Owned Bounded Actions
Bounded browser action proposals SHALL remain browser-owned for validation,
approval, execution, and receipts. The gateway and model MAY propose bounded
browser actions such as click, draw, or annotate, but the gateway SHALL NOT
execute browser-local actions directly. The first implementation slice MAY defer
actual action execution as a follow-up, but it SHALL still preserve the proposal
and receipt boundary.

#### Scenario: Gateway proposes a browser action
- **WHEN** a browser-agent turn returns a click, draw, or annotate proposal
- **THEN** the extension validates that the proposal matches the current page,
  action allowlist, and approval policy
- **AND** only the extension may execute the browser-local action
- **AND** the gateway records the proposal as non-executed until it receives a
  browser action receipt

#### Scenario: First slice does not execute proposed browser actions
- **WHEN** the first implementation slice receives a browser action proposal but
  local execution is not implemented
- **THEN** the extension refuses or defers the proposal locally
- **AND** records a receipt showing that execution did not occur
- **AND** the gateway does not execute the action on the extension's behalf

### Requirement: Browser Action Receipts
Every executed, refused, or deferred browser action SHALL produce a receipt
linked to session, branch, turn, task, proposal, page evidence, approval,
result, and timestamp.

#### Scenario: Browser action is executed
- **WHEN** the extension executes a validated browser action
- **THEN** it records a receipt with the session id, branch id, turn id, task id,
  proposal id, page evidence id, approval id when approval was required, action
  result, and timestamp
- **AND** the gateway links that receipt to the browser-agent turn and any
  related task

#### Scenario: Browser action is refused
- **WHEN** the extension refuses a browser action because it fails validation,
  lacks approval, targets the wrong page, or is not implemented
- **THEN** it records a refusal receipt with the same linkage fields and a
  refusal reason
- **AND** the overlay can show the refusal as part of browser-turn progress

### Requirement: Persona Settings Do Not Change Safety
Browser persona settings such as assistant name, voice, tone, and language SHALL
NOT relax browser action allowlists, approval requirements, local validation,
or receipt requirements.

#### Scenario: User changes browser assistant persona
- **WHEN** the user changes the assistant name, voice, tone, or language for a
  browser session or global profile
- **THEN** browser-agent replies may reflect that presentation setting
- **AND** browser action proposals still use the same allowlists, approvals,
  local checks, and receipt rules as before the persona change
