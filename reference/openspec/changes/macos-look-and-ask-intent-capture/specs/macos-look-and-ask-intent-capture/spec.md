# macOS Look & Ask Intent Capture

## ADDED Requirements

### Requirement: Look & Ask binds the source before Ag takes focus

The macOS surface SHALL bind the verified frontmost application process
generation and focused-window identity when the user explicitly invokes Look &
Ask, before showing or focusing the Ag panel. It SHALL NOT infer a prior source
after focus has moved.

#### Scenario: User invokes Look & Ask from another app

- **WHEN** the user invokes Look & Ask while a supported source window is
  frontmost
- **THEN** the turn binds that app, process generation, signing identity, and
  focused-window identity before Ag takes focus
- **AND** later capture can target only that binding.

#### Scenario: No stable source window exists

- **WHEN** the user invokes Look & Ask without a stable focused source window
- **THEN** transcript capture remains available
- **AND** context attachment is unavailable rather than guessed.

### Requirement: Context attachment is explicit and off by default

Every Look & Ask turn SHALL begin with context attachment disabled. The current
turn SHALL require an explicit user choice before any AX traversal, and SHALL
require a separate explicit choice before any pixel capture. The choices SHALL
reset after submit, cancel, dismissal, or turn replacement.

#### Scenario: User submits a normal summoned turn

- **WHEN** the user records or types a transcript without enabling Attach
  context
- **THEN** the surface performs no AX traversal and no ScreenCaptureKit capture
- **AND** submits transcript-only intent evidence.

#### Scenario: User enables semantic context only

- **WHEN** the user enables Attach context but leaves screenshot attachment off
- **THEN** the surface may capture one bounded AX snapshot after verifying
  Accessibility authority
- **AND** performs no pixel capture or ScreenCaptureKit enumeration.

### Requirement: Microphone, Accessibility, and Screen Recording remain separate

Microphone authority SHALL cover transcript audio only. Accessibility authority
SHALL cover the explicitly requested one-shot AX attachment only. Screen
Recording authority SHALL cover only the independently enabled screenshot of
the same bound focused window. No permission SHALL imply either other
permission or a product release grant.

#### Scenario: Screen Recording is denied

- **WHEN** transcript capture succeeds and the user has approved AX context but
  Screen Recording is denied
- **THEN** transcript plus allowed AX evidence remains reviewable
- **AND** screenshot attachment fails visibly without blocking submission.

#### Scenario: Accessibility is denied

- **WHEN** Microphone capture succeeds but Accessibility is denied
- **THEN** the exact transcript remains reviewable and submittable without
  semantic context
- **AND** no screenshot authority is inferred.

### Requirement: Attached evidence uses the existing Mac privacy bounds

The macOS surface SHALL capture at most one locally redacted AX snapshot and,
when separately enabled, one focused-window screenshot for the exact bound app
and window. AX and image evidence SHALL satisfy the bounds and sensitive-content
suppression defined by `privacy-first-macos-surface` before preview or release.

#### Scenario: AX content exceeds a bound

- **WHEN** the source tree exceeds 128 nodes, depth 8, 256 characters per label,
  or 16 KiB serialized context
- **THEN** the surface deterministically truncates it and reports the bound in
  preview
- **AND** secure subtrees and prohibited sensitive windows remain excluded.

#### Scenario: User enables screenshot attachment

- **WHEN** the user separately enables a screenshot for the bound source
- **THEN** ScreenCaptureKit captures only that same focused window after pre-
  and post-capture identity checks
- **AND** the result is a metadata-stripped JPEG no larger than 1 MiB with a
  longest edge no greater than 1280 pixels.

### Requirement: App or window change makes context stale

The surface SHALL revalidate the app/process generation and focused-window
identity immediately before submission. Any app switch, process replacement,
focused-window change, permission loss, lock, sleep, or capture-generation
replacement SHALL make the attachment stale and SHALL block its release.

#### Scenario: Focused window changes after capture

- **WHEN** the user changes the focused window after AX or screenshot capture
- **THEN** the preview marks the attachment stale
- **AND** submission with that attachment is blocked until the user explicitly
  recaptures or removes context.

#### Scenario: User removes stale context

- **WHEN** an attachment is stale and the user chooses Remove context
- **THEN** the exact transcript remains available
- **AND** the turn may be submitted as transcript-only intent evidence.

### Requirement: The user previews the exact redacted release

Before releasing attached context, the surface SHALL show the exact transcript,
source binding, redacted AX evidence, redaction/truncation report, optional
screenshot preview and metadata, destination, and retention statement. Approval
SHALL bind immutable serialized bytes and evidence digests; any change SHALL
invalidate approval.

#### Scenario: Transcript changes after preview

- **WHEN** the user edits the transcript after approving a preview
- **THEN** the previous approval is invalid
- **AND** no bytes are released until a fresh preview is approved.

#### Scenario: Approved destination redirects

- **WHEN** the configured endpoint redirects the approved request
- **THEN** the client rejects the redirect without forwarding the body
- **AND** no alternate destination receives evidence.

### Requirement: Submission creates durable non-executable intent

The gateway SHALL idempotently append the exact user transcript and approved
typed evidence refs as one durable Look & Ask intent. The record SHALL identify
itself as non-executable and SHALL NOT create or imply an action proposal, work
task, queued or executing run, repository mutation, deployment request, release
switch, promotion, smoke, or completed outcome.

#### Scenario: User submits approved transcript and evidence

- **WHEN** the gateway accepts a fresh approved Look & Ask envelope
- **THEN** it stores one durable intent with exact transcript, provenance,
  source binding, evidence digests, redaction/bounds, and retention metadata
- **AND** its initial lifecycle is captured or needs alignment
- **AND** no executable or release lifecycle begins.

#### Scenario: Client retries the same submission

- **WHEN** the client retries with the same stable submission identity and
  exact approved envelope
- **THEN** the gateway returns the same durable intent identity
- **AND** appends no duplicate intent or evidence admission.

### Requirement: Evidence and later proposals grant no action authority

AX text, pixels, and derived interpretations SHALL remain untrusted evidence.
A later action, implementation, or release request SHALL require its own
explicit typed authority and SHALL pass the existing proposal, local approval,
worker claim, verification, and promotion boundaries.

#### Scenario: Screen content resembles an instruction

- **WHEN** attached AX text or pixels contain language asking Ag to click,
  execute code, deploy, or approve work
- **THEN** that language remains evidence only
- **AND** the Look & Ask submission performs none of those effects.
