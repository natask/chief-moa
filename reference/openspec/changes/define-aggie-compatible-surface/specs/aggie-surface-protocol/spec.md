# Aggie surface protocol specification

## ADDED Requirements

### Requirement: Versioned bounded surface envelopes

The gateway and compatible surfaces SHALL exchange versioned envelopes bounded
to 64 KiB. The implementation SHALL support current version N and previous
version N-1, ignore benign unknown additive fields, and reject versions or
semantic types for which no supported meaning exists. Additive fields whose
names represent executable or credential authority, or whose values match
credential-token or OAuth callback-code shapes, SHALL fail closed. Forward
compatibility does not permit smuggling authority through ignored data.
Credential-authority names include bounded case/separator-normalized token,
OAuth token, private-key, API-key, client/provider-secret, authorization and
password families.

#### Scenario: Previous-version surface reconnects

- **WHEN** a surface offers only N-1
- **THEN** the gateway selects N-1 and validates the same session, surface,
  event, proposal, approval and receipt invariants

#### Scenario: No version overlap

- **WHEN** a surface offers no supported version
- **THEN** negotiation fails without accepting a turn or action

### Requirement: Replay and reconnect are bounded and unambiguous

Events SHALL have monotonic per-session sequences and stable message IDs.
Exact duplicates SHALL be harmless. Conflicting sequence or message-ID reuse
and cross-session replay SHALL fail. A cursor older than the bounded replay
window SHALL receive a snapshot-required result. Reconnect delay SHALL use
bounded full-jitter exponential backoff.

The replay accumulator SHALL accept only gateway-originated event families.
Client turns, approvals, receipts, hello and resume commands are not replay
events even when a caller adds a sequence field.

#### Scenario: Client resumes behind retained history

- **WHEN** the requested cursor predates the retained replay window
- **THEN** the protocol requires a snapshot instead of presenting partial
  history as complete

### Requirement: Local action authority remains on the surface

Server or model output SHALL be represented only as a typed action proposal.
Eligibility SHALL require matching session and surface, unexpired proposal,
matching local state preconditions and any required explicit approval. The
protocol SHALL reject executable or credential-bearing fields and SHALL never
execute an effect.

An approval SHALL be a validated protocol envelope bound to the proposal
message and the digest of its canonical version, session, surface, timestamp,
kind, approval class, expiry, preconditions and parameters. Its decision time
SHALL fall between proposal creation and the eligibility check. A local receipt
SHALL identify both the proposal ID and proposal message, and its `reply_to`
SHALL match that proposal message. These bindings provide protocol correlation;
they do not claim device identity, signing, or native executor proof.
Approval scope SHALL additionally match the complete canonical surface object:
ID, kind, mode, and the same presence/value semantics for optional device ID.

#### Scenario: Proposal is stale

- **WHEN** current local state differs from the proposal preconditions
- **THEN** eligibility returns `stale_state` and no execution occurs

#### Scenario: Approved proposal is mutated before execution

- **WHEN** any canonical proposal field differs from the proposal covered by
  the approval digest
- **THEN** eligibility returns an approval-digest mismatch and no execution
  occurs

### Requirement: Echo adapter precedes external runtimes

The protocol SHALL provide a deterministic, provider-neutral echo backend with
metadata, health, text turn, run, resume, cancel and artifact operations and no
external I/O. Run and artifact retention SHALL be bounded and SHALL evict the
oldest run and its artifacts as one unit.

#### Scenario: Echo run completes

- **WHEN** a valid text turn starts an echo run
- **THEN** the adapter produces a deterministic terminal run and content-digest
  artifact without a provider credential or network call
