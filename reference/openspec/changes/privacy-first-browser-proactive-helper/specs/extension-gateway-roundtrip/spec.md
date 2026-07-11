## MODIFIED Requirements

### Requirement: Unified Browser Agent Turn Path
The gateway SHALL expose `POST /v1/browser/turns` as the canonical
browser-agent turn path for typed page questions, describe-page requests, and
committed browser voice transcripts. Browser turns SHALL be linked to a session,
branch, turn id, source kind, browser-agent owner, page evidence, and status
resource. A disclosed proactive acceptance that contains only a packaged generic
prompt, no page evidence/identity/content, and no browser-action capability SHALL
use only `POST /v1/proactive/turns` tagged `proactive_accept_v1`; it is not a
voice turn, current-page question, or browser-agent turn.

#### Scenario: Typed page question enters browser-agent turn path
- **WHEN** the user submits a question that requests information about the
      current page
- **THEN** the extension posts the question to `POST /v1/browser/turns`
- **AND** the rendered reply originates from that browser-agent turn

#### Scenario: Describe page uses the same turn path
- **WHEN** the user runs describe page with a gateway configured
- **THEN** the extension posts or references current page evidence
- **AND** sends the describe request to `POST /v1/browser/turns`

#### Scenario: Committed browser voice transcript is a page question
- **WHEN** browser voice commits a transcript that requests current-page context
- **THEN** the extension commits it through `POST /v1/browser/turns`

#### Scenario: Proactive generic text is accepted
- **WHEN** the user accepts a disclosed packaged suggestion that contains no page
      content, identity, or evidence
- **THEN** the extension MAY issue one `POST /v1/proactive/turns` text request
- **AND** the text-only response cannot negotiate or execute browser actions
- **AND** any unexpected action-shaped field is refused with a bounded local
      receipt and no additional network request

### Requirement: Browser Action Receipts
Every negotiated browser-agent action SHALL produce the normal receipt.
For an action that is executed, refused, or deferred, that receipt is linked to
session, branch, turn, task, proposal, page evidence, approval, result, and
timestamp. The proactive generic text path does not negotiate browser-action
capability: an unexpected action-shaped response field is a text-protocol
violation, not a preserved `action_proposal`. It SHALL be dropped before
execution and recorded only as a bounded content-free local refusal receipt so
the one-request privacy boundary does not upload the unnegotiated field.

#### Scenario: Negotiated browser action is executed or refused
- **WHEN** a browser-agent turn preserves a validated action proposal
- **THEN** the extension records the normal fully linked browser action receipt
- **AND** the gateway links it to the browser-agent turn and related task

#### Scenario: Proactive text response violates its capability
- **WHEN** a proactive generic-text response contains any nested or scalar
      `action`, `actions`, `proposal`, or `proposals` key, including a null value,
      or the bounded response scan truncates before proving absence
- **THEN** the extension does not preserve or execute it as an action proposal
- **AND** it stores only a bounded local refusal receipt with no raw field value
- **AND** it makes no additional network request

## ADDED Requirements

### Requirement: Proactive Gateway Turn Is A Separate Strict Capability
The gateway SHALL expose authenticated `POST /v1/proactive/turns` as a separate
text-only endpoint. It SHALL accept only the exact top-level fields `source`,
`transcript`, `modality`, and `client`; require
`source: proactive_accept_v1`, `modality: text`, one packaged allowlisted
transcript, and the exact bounded browser client shape; reject unknown or
oversized fields; and reject page/screen/context/evidence, action, task,
workflow, broker, agent, run, session, branch, and arbitrary-instruction data.
Unlike legacy local routes, this capability SHALL require a configured gateway
token and an exact bearer match in every runtime mode.

#### Scenario: Exact packaged request arrives
- **WHEN** an authenticated client posts the allowlisted body disclosed by the
      extension-owned confirmation
- **THEN** the gateway accepts that body without enriching it with page,
      conversation, task, or agent context
- **AND** returns only bounded display/text metadata and an empty action
      capability

#### Scenario: Local gateway has no configured token
- **WHEN** a page or client calls the proactive endpoint on a tokenless local
      gateway
- **THEN** the endpoint returns unauthorized before reading provider state
- **AND** no provider request or durable write occurs

#### Scenario: Request contains extra context or an unrecognized prompt
- **WHEN** the body contains an unknown/nested page, screen, context, evidence,
      action, task, workflow, broker, agent, run, session, or branch field, or a
      transcript outside the packaged allowlist
- **THEN** the endpoint rejects the request before model invocation
- **AND** it creates no durable record or execution

### Requirement: Proactive Gateway Turn Bypasses Execution And Persistence
The proactive endpoint SHALL call the configured model provider directly under
a fixed text-only system contract. It SHALL NOT enter the voice/browser turn
router, offer tools, start an agent run, create a task/workflow, publish a broker
event, or add the request/response to conversation or turn storage. The endpoint
SHALL disclose that the configured provider still processes the packaged prompt
according to that provider's data policy; gateway non-persistence is not a
provider non-retention claim.
Provider calls SHALL use exact one-system/one-user envelopes with no tool or
function declaration, hard output-token and response-byte limits, and one abort
deadline that remains active through response-body consumption. Vertex token
exchange SHALL use the same timed, bounded response discipline.

#### Scenario: Configured provider returns proactive text
- **WHEN** a valid proactive request is processed with a configured provider
- **THEN** exactly one direct text-only model call receives the packaged prompt
- **AND** no router, tool, agent, task, workflow, or broker activation is possible
- **AND** conversation, turn, task, workflow, broker-event, and agent-run stores
      remain unchanged

#### Scenario: Provider stalls or returns an oversized/executable response
- **WHEN** either supported provider stalls after headers, exceeds the response
      byte limit, or returns a tool/function call
- **THEN** the bounded provider operation aborts or rejects the response
- **AND** no executable output or durable record is created

#### Scenario: Provider response attempts to return an action
- **WHEN** provider output or an upstream response contains an action or proposal
      capability outside the bounded text response
- **THEN** the gateway does not expose an executable capability
- **AND** the extension independently treats any such returned field or an
      incomplete bounded scan as a local protocol violation

### Requirement: Proactive Gateway Smoke Proves The Negative Boundary
The gateway SHALL provide a smoke test that runs on an isolated port and data
directory, exercises both configured provider envelopes and fallback plus
tokenless auth, malformed, unknown-field, unrecognized-prompt, action/context,
stalling, oversized, and executable-output cases, compares the browser/gateway
prompt allowlists, and compares durable stores before and after.

#### Scenario: Isolated proactive smoke completes
- **WHEN** the proactive gateway smoke runs against the candidate gateway
- **THEN** one exact allowlisted request returns bounded text or the documented
      deterministic fallback
- **AND** every non-allowlisted request fails closed
- **AND** conversation/turn, task, workflow, broker-event, and agent-run store
      counts and contents are unchanged
