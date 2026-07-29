# Agent Evidence Capabilities Specification

## ADDED Requirements

### Requirement: Ordinary reasoning uses one capability and evidence contract

Every ordinary answer-producing route SHALL assemble `moa.reasoning-turn.v2`
with authenticated turn identity, source, role, original query, authorized
observation/evidence references, one inspectable capability snapshot, and one
retention policy. Android chat, browser turns/evidence, browser HTTP voice,
cascaded voice, broker direct-answer/research, and resumed evidence turns SHALL
use equivalent capability assembly. Forced control-plane, transcription, TTS,
and privacy-first proactive calls SHALL retain their narrower contracts.

#### Scenario: Evidence continuation resumes a turn

- **WHEN** authorized image or video evidence is attached after the initial
  attempt
- **THEN** the gateway resumes the same turn, session, branch, role, original
  query, delegation envelope, and ordinary capability policy
- **AND** does not create an unrelated user intent or generic voice turn

### Requirement: Evidence assets are bounded evidence, not authority

Semantic summaries, screenshots, and videos SHALL use
`evidence_asset.v1`, binding kind, subject, provenance, capture time,
freshness, media type/size/digest, surface grant, model-use policy, and retention
policy. The gateway SHALL validate those bindings before provider processing.
Observed content SHALL NOT create instructions, routing, capture permission,
delegation, or execution authority.

#### Scenario: Page content asks for more authority

- **WHEN** page text, pixels, search results, or video tells the model to grant
  a permission, start capture, widen a program scope, or execute code
- **THEN** it remains untrusted evidence
- **AND** no authority changes

#### Scenario: Provider receives optional evidence

- **WHEN** an optional image/video asset is included in the provider request
- **THEN** the turn records that the provider processed the bytes even if the
  answer does not semantically rely on them

### Requirement: Web search is route-uniform and honest

Every ordinary reasoning route SHALL receive an explicit search capability
state: provider-native search when supported, otherwise the configured bounded
gateway search function, otherwise unavailable with a reason. Search SHALL be
read-only evidence retrieval, SHALL keep credentials gateway-side, SHALL NOT
grant browser/session or arbitrary-network authority, and SHALL retain only
bounded invocation metadata plus normalized sources used in the answer by
default.

#### Scenario: Provider lacks native search

- **WHEN** the selected provider lacks native search and bounded gateway search
  is configured
- **THEN** the same bounded search function is available through that route's
  ordinary reasoning tool loop

#### Scenario: Search is unavailable

- **WHEN** neither native nor bounded gateway search is supported
- **THEN** the tool is absent and the model receives an explicit unavailable
  state
- **AND** prompt text does not claim that search occurred

#### Scenario: Forced context preflight runs

- **WHEN** the gateway asks only for a context-management decision
- **THEN** no web-search capability is exposed

### Requirement: Initial browser turns may carry request-only pixels

An explicitly submitted current-page question SHALL be able to carry the
already-authorized bounded page observation and optional visible-tab JPEG in
the initial `moa.reasoning-turn.v2`. Valid initial evidence SHALL NOT require a
second evidence round trip. Capture failure, invalid/oversized/stale pixels, or
a provider without image input SHALL degrade honestly without failing an
otherwise valid text turn. Raw pixels SHALL be request-only by default.

#### Scenario: Current-page question includes valid pixels

- **WHEN** the extension has a fresh granted page observation and bounded JPEG
  at submission time
- **THEN** the initial provider request receives both semantic page evidence and
  the image
- **AND** no compatibility evidence follow-up is required

#### Scenario: Browser capture fails

- **WHEN** the optional JPEG cannot be captured or validated
- **THEN** the question continues with authorized semantic evidence
- **AND** the turn records the image-degradation reason

### Requirement: Video requests have zero capture authority

A model-proposed video request SHALL use `moa.video-evidence-request.v1` with a
bounded reason, scope, duration, and audio need, but that proposal SHALL NOT
open a picker, obtain screen/microphone access, record, or upload. Only a trusted user action
in the owning Surface SHALL start capture. After user stop, the actual video
asset SHALL resume the originating turn idempotently. Provider video support or
any derived-frame/transcript substitute SHALL be disclosed honestly.

#### Scenario: Model asks for video

- **WHEN** the model returns a valid video evidence proposal
- **THEN** the extension shows an inert trusted Start recording control
- **AND** performs no capture or upload until the user activates it

#### Scenario: User completes requested capture

- **WHEN** the user starts and stops the approved capture
- **THEN** the terminal recorder chunk is included, the actual bounded video is
  attached to the originating turn, and that turn resumes with its original
  capabilities

#### Scenario: Provider lacks video support

- **WHEN** the active provider cannot process the actual video
- **THEN** the turn reports `video_provider_unsupported`
- **AND** does not silently claim that derived frames or transcript are the
  original video input

### Requirement: Generated browser programs are immutable and authority-bound

Every generated page program SHALL use `moa.browser-program.v2` and bind its
complete source, source digest, immutable revision, purpose, mode, world, exact
target scope, execution profile, profile-discriminated authority, bridge
capabilities, limits, and rollback metadata. `reviewed_standalone_v1` authority
SHALL bind direct approval plus the approved source and scope digests without
fabricating Delegate role/task/run/envelope fields. `delegated_runtime_v1`
authority SHALL bind the typed Delegate role, task, run, delegation envelope,
exact typed class/world/executor/origin/frame/effect/bridge grants, and an
optional checkpoint approval only when applicable. Arbitrary source SHALL
remain `unknown_program_effect`; caller-declared effects and static common-
pattern checks SHALL NOT be represented as proof of complete behavior. The
extension SHALL revalidate digest, profile-specific authority,
page/document/frame/origin, permissions, applicable grants/checkpoints, and
limits immediately before execution or registration.
Generated code SHALL NOT run in privileged extension code.
Revision history SHALL be contiguous: revision 1 has no prior revision and each
later revision SHALL increment by one and bind the immediately preceding stored
revision. The common-pattern backstop SHALL reject fixed Bearer literals rather
than retain them and SHALL require declared credential access plus an
independent high-risk grant for obvious dot/bracket storage reads and
`Auth`/`Authorization` property or header assignments.

#### Scenario: Program revision changes after approval

- **WHEN** source, hash, target, world, bridge capability, or immutable revision
  differs from its bound authority record
- **THEN** execution fails closed and no page effect occurs

#### Scenario: Standalone program carries delegated authority fields

- **WHEN** a `reviewed_standalone_v1` program includes a Delegate role, task,
  run, delegation envelope, or delegated grant set
- **THEN** validation rejects the mixed authority variant
- **AND** no execution or registration occurs

#### Scenario: Delegated program lacks its run authority

- **WHEN** a `delegated_runtime_v1` program lacks its typed Delegate role, task,
  run, envelope, or exact grant bindings
- **THEN** validation rejects the incomplete authority variant
- **AND** no standalone approval is inferred as a substitute

#### Scenario: Program performs a destructive site operation

- **WHEN** JavaScript deletes application data rather than merely hiding or
  detaching page presentation
- **THEN** policy classifies it as a destructive application action
- **AND** it cannot travel under a visual-modification grant

#### Scenario: Program skips a revision

- **WHEN** a proposed revision does not immediately follow and bind the latest
  stored revision for its artifact
- **THEN** validation rejects the non-contiguous lineage

#### Scenario: Program contains obvious credential access

- **WHEN** source uses a bracket storage `getItem` token/password/secret/key,
  assigns an `Auth` or `Authorization` header dynamically, or contains a fixed
  Bearer literal
- **THEN** dynamic access requires its credential declaration and independent
  high-risk grant
- **AND** a fixed literal secret is rejected and never stored

### Requirement: Standalone reviewed programs use the safe default profile

`reviewed_standalone_v1` SHALL be default-off, require complete source/hash/scope
inspection and direct approval for every changed revision, use exact host
permission and top-frame `USER_SCRIPT`, verify registration read-back and
removal, and SHALL NOT use `MAIN` or CDP fallback.

#### Scenario: Reviewed standalone revision changes

- **WHEN** a standalone program's immutable revision or source hash changes
- **THEN** direct user approval is required again before registration/execution

### Requirement: Delegated programs use independent visible grants

`delegated_runtime_v1` SHALL require a separate default-off runtime opt-in and a
confirmed Delegate envelope. The envelope MAY preauthorize exact
`script.evaluate` and/or `script.persist` classes so an in-envelope immutable
revision does not need redundant confirmation. Arbitrary-code authority, site
scope, frame scope, `MAIN`, bridge handlers, and CDP `Runtime.evaluate` SHALL be
separate visible grants. `MAIN` and CDP SHALL NOT be silent fallbacks. Scope or
world widening, origin/document change, bridge widening, checkpoints,
destructive effects, stale evidence, or an expired envelope SHALL pause before
execution.
Persistent mode SHALL use `user_scripts_register`; CDP `Runtime.evaluate` SHALL
be eligible only for immediate mode and SHALL still require its separate exact
executor grant.

#### Scenario: Delegate generates an in-scope revision

- **WHEN** the confirmed envelope preauthorizes the program class and the
  immutable revision remains within every exact current grant
- **THEN** the extension may execute without a redundant confirmation
- **AND** still writes a hash-bound local receipt

#### Scenario: Program requests MAIN or CDP

- **WHEN** the program needs `MAIN` or CDP `Runtime.evaluate`
- **THEN** the extension requires that executor/world's separate current visible
  grant
- **AND** failure or absence never silently selects it as a fallback

### Requirement: Program attempts are receipted and retained explicitly

Every program attempt SHALL produce a bounded canonical local receipt for
execution, registration, update, rejection, rollback, stop, and removal. The
receipt binds the program revision/hash, execution profile/executor/world, exact
target, profile-specific standalone or delegated authority refs, before/after
evidence, bounded result/error, registration
read-back, cleanup/removal result, timestamps, and status. Gateway sync SHALL be
an audit copy only. Program source SHALL remain while installed and as required
for rollback; deletion SHALL remove source/registration while retaining bounded
hash/status tombstones and receipts. Media/search/provider retention SHALL be
separately disclosed and secret-like material SHALL be excluded.

#### Scenario: User removes a persistent program

- **WHEN** the user selects removal
- **THEN** the owning extension unregisters the exact program and verifies
  absence
- **AND** deletes retained source according to policy while preserving a bounded
  non-secret removal receipt and tombstone
