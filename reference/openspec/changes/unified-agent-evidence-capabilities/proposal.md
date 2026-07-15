# Unified Agent Evidence Capabilities

## Why

Moa's reasoning routes do not currently expose the same capabilities. Search is
provider- and route-dependent. The browser captures a screenshot but stages it
through a second request and then omits its pixels from model input. Broker
evidence references are not consistently resolved. Browser video is a separate
manual voice turn rather than evidence attached to the question that needed it.
Generated page evaluation exists technically, but not as a model-visible,
authority-bound program contract.

These are routing and contract defects, not primarily failures of model
judgment. A model cannot choose a capability that the selected route did not
offer, and stored evidence is not useful to reasoning unless the provider
request can resolve it.

## What Changes

- Define `moa.reasoning-turn.v2` as the ordinary answer-producing envelope for
  Android, browser, cascaded voice, broker direct-answer/research, and resumed
  evidence turns.
- Define `evidence_asset.v1` for bounded semantic, image, and video evidence
  with provenance, capture grant, digest, freshness, model-use, and retention
  metadata.
- Make web-search availability explicit and route-uniform: native provider
  search first, bounded gateway search second, or an honest unavailable state.
- Include an already-authorized browser semantic snapshot and optional bounded
  JPEG in the initial reasoning turn. Pixels are request-only by default and
  are evidence, never instructions or action authority.
- Define `moa.video-evidence-request.v1` as a zero-authority model proposal.
  Capture starts only from a trusted user action, and the resulting video
  resumes the original turn rather than creating an unrelated intent.
- Define `moa.browser-program.v2` for inspectable, hash-bound generated page
  programs, with separate `reviewed_standalone_v1` and
  `delegated_runtime_v1` authority profiles.
- Require durable, bounded receipts and explicit retention/deletion semantics
  for search, images, video, generated source, registrations, and page effects.

## Capabilities

### New Capabilities

- `agent-evidence-capabilities`: Route ordinary questions through one reasoning
  contract with search, resolved evidence, multimodal continuation, and
  authority-bound generated browser programs.

### Modified Capabilities

- `browser-situated-agent-experience`: Generated page programs use an explicit
  execution profile and delegation authority rather than an implicit universal
  policy.
- `extension-ui-self-extension`: The older Tier C rules become the
  `reviewed_standalone_v1` profile; the accepted Tweeks direction uses the
  separately opted-in `delegated_runtime_v1` profile.

## Boundaries

- The gateway owns provider/search credentials, turn assembly, capability
  snapshots, evidence metadata/blob references, generated program history, and
  synced receipts.
- The owning Surface alone owns screen/video capture, platform permission UI,
  browser registration/evaluation, local revalidation, stop/rollback controls,
  and canonical local effect receipts.
- Model output may request evidence or propose a browser program. It cannot open
  a capture picker, record/upload media, grant a world/origin/frame/bridge
  capability, or execute page code.
- Page, screen, search, image, and video content are untrusted evidence. None can
  widen routing, permission, delegation, or execution authority.
- Generated code never runs in privileged extension code. Page code receives no
  extension capability except a named, separately authorized and receipted
  bridge handler.

## Non-Goals

- No hidden, continuous, or model-started screen/video capture.
- No promise that every provider supports image or video input; unsupported
  media degrades or blocks honestly according to the contract.
- No arbitrary network access from QuickJS, a userscript, or CDP evaluation.
- No universal permission for `MAIN`, all frames, CDP, destructive site actions,
  or broad origins.
- No Android pixel capture until Android owns a visible platform grant and a
  separately verified capture implementation.
- No deployment or active promotion in this documentation unit.

## Success Criteria

- Every ordinary reasoning route receives native search, the bounded gateway
  fallback, or an explicit unavailable state; forced control-plane calls do not
  receive search.
- One browser page question can complete from the initial request with bounded
  semantic context plus one optional JPEG and no evidence follow-up round trip.
- Model output alone starts no video capture. After the user starts and stops a
  recording, the actual video resumes the original turn with its original
  query, role, branch, capabilities, and authority.
- A generated insertion, removal/hide, and drawn overlay can be proven in an
  isolated browser fixture with the correct execution profile, grants, source
  digest, before/after evidence, local receipt, stop, and removal/rollback.
- No active contract simultaneously claims that direct per-revision approval,
  `USER_SCRIPT`-only execution, and no CDP apply universally while also claiming
  that delegated revision reuse, `MAIN`, and CDP are universally allowed.

## Verification

- `openspec validate unified-agent-evidence-capabilities --strict`
- `git diff --check`
- Later implementation lanes run gateway checks, extension verify/smoke, and
  isolated-profile browser QA before any packaging or promotion.
