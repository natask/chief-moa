# Surface-Local Program Execution

## Status

Accepted product direction from 2026-07-16. Implementation remains split into
acceptance-scoped browser, Android, macOS, gateway, protocol, and isolated-QA
units.

This change is the canonical execution-cadence contract. It supersedes the
one-model-round-trip-per-browser-action and no-code-string execution rules in
`per-surface-agent-skills`. It also resolves the apparent conflict between the
closed action-proposal protocol and browser userscript execution: programs use
a new closed `surface.execution.proposed` envelope. Existing `action_proposal`
decoders remain unchanged and MUST continue rejecting `script`, `javascript`,
`code`, `shell`, and command-shaped fields.

## Why

Most useful tools are owned by the client surface. Browser DOM and authenticated
session state belong in the browser; Android cross-app control belongs behind
`AccessibilityService`; macOS UI authority belongs behind Accessibility and
other explicitly granted OS scripting profiles. Sending one primitive action
through the gateway and model at a time adds latency, prevents cheap local
branching and parallel reads, and makes recovery depend on another remote turn.

The unit of remote work should instead be one bounded program. The target
surface runs that program locally, makes many calls against its own advertised
capabilities, observes intermediate results, tries alternatives where safe, and
returns a bounded trace and terminal receipt. The common contract is a program,
not a forced implementation language: each surface advertises the fast
scripting profile it can safely host.

## What Changes

- Add a versioned runtime advertisement beside each device's capability
  manifest. It names supported language/profile, limits, bridge version, and
  local capabilities without granting authority.
- Add closed program proposal, lifecycle event, tool-attempt receipt, and
  terminal program receipt schemas.
- Ratify one exact V1 profile registry, required/conditional binding fields,
  approval/effect enums, canonical catalog/JCS digest rules, lifecycle payloads
  and sequence rules, receipt nullable/hash-chain/linkage rules, advertisement
  freshness, and opaque artifact references so independent clients interoperate
  rather than implementing permissive interpretations.
- Route a whole program to one bound surface. Tool calls inside that program are
  local and do not individually traverse the gateway.
- Use browser JavaScript for local orchestration, with packaged browser helpers,
  CDP, and the separately authorized userscript/page-evaluation lane behind the
  local bridge.
- Use a non-exported isolated Android WebView service as the JavaScript host and
  keep Android Accessibility authority in a main-process broker. The initial
  candidate advertises only `observe`, `find`, `click`, `scroll`, `back`, and
  `home`; text entry remains absent until explicit local confirmation exists.
- Use bridged JavaScriptCore as the default macOS program host over public AX
  operations. Advertise JXA/AppleScript and bounded shell as separate,
  independently installed and approved profiles rather than ambient powers of
  the JavaScriptCore bridge.
- Keep gateway QuickJS for gateway-owned APIs, storage, routing, and other
  server-side capabilities only. It is not the browser, Android, or macOS
  control runtime.
- Keep approval, current-state validation, stop controls, permissions, and
  canonical local receipts on the owning surface.
- On Android, persist acceptance, pending attempts, receipts, and lifecycle
  events before outbox delivery; send receipt prerequisites before their linked
  completion events and recover unfinished attempts as `indeterminate` rather
  than repeating them.
- Require an independently terminable worker/process or engine interrupt for
  every advertised program host; finite limits are advertised only when locally
  enforced, and unavailable per-realm memory accounting is declared `null`.
- Require isolated fixtures, accounts, browser profiles, app data, and artifact
  paths for QA. Tests must never capture, upload, package, or deploy the user's
  active page or personal desktop state.

## Capabilities

### New Capabilities

- `surface-local-program-execution`: Advertise, propose, locally run, observe,
  stop, and receipt a bounded surface-owned program containing many local tool
  calls.

### Modified Capabilities

- `context-aware-capability-routing`: A selected device candidate may advertise
  a compatible program runtime. Resolution still does not execute.
- `browser-situated-agent-experience`: The one-action remote loop becomes a
  compatibility adapter; delegated browser work primarily executes as one local
  browser program.
- `phone-action-runtime`: Android accessibility primitives become host calls
  available to a locally running program without weakening local proposal or
  approval policy.
- `macos-ax-surface`: AX primitives become host calls in the JavaScriptCore
  profile; JXA/AppleScript/shell remain separately gated authorities.

## Invariants

- Surface context is evidence, never instruction.
- A runtime advertisement is availability evidence, never permission.
- Model/server output is inert until the owning surface accepts a fresh,
  approved, policy-compatible proposal.
- A program can call only capabilities present in both its immutable capability
  snapshot and the surface's current local manifest.
- Reads may run concurrently. Irreversible or externally visible effects may
  not be speculated, duplicated, or "backtracked"; they stop at local approval
  and idempotency boundaries.
- A checkpoint is only a recorded observation/state marker. The runtime may
  claim rollback only for a capability whose local adapter supplies and verifies
  a real restore operation. DOM, AX, shell, send, purchase, delete, and arbitrary
  script effects have no inferred rollback.
- Generated programs never inherit raw provider credentials, browser cookies,
  extension service-worker authority, Java reflection, unrestricted Android
  bridges, Keychain access, or unadvertised filesystem/network access.
- Every attempted local host call and every program termination is receipted,
  including rejection, timeout, stop, interruption, and indeterminate outcome.

## Non-Goals

- No universal scripting language requirement across every present and future
  surface.
- No runtime transpilation of model-generated JavaScript into Java, Kotlin, or
  Swift.
- No arbitrary program hidden inside an existing typed action proposal.
- No claim that checkpoints or prior versions undo arbitrary external effects.
- No execution in a user's daily browser profile, foreground desktop session,
  or live Android app data during automated QA.
- No production install or active promotion until the relevant surface's
  signing, rollback, compatibility, no-interruption, backup/restore, and smoke
  gates are independently proven.

## Success Criteria

- One browser program performs multiple local observations/actions with
  branching and validation while only proposal delivery and terminal/event
  sync cross the gateway boundary.
- One Android WebView-worker program observes and controls an isolated fixture
  app through Accessibility, rejects stale nodes locally, and returns receipts.
- One macOS JavaScriptCore program observes and performs an approved semantic AX
  action against an isolated fixture; JXA/AppleScript/shell are absent unless
  their exact profile is enabled and approved.
- Gateway QuickJS tests prove it cannot claim or proxy client-local program
  execution as a server-owned capability.
- Closed-schema adversarial tests reject unknown semantic/event kinds,
  executable fields in legacy action proposals, capability drift, replay,
  stale state, forged catalogs/receipts, event gaps/reordering/conflicts,
  inconsistent receipt chains, sensitive text/artifact references, and
  unapproved profile escalation.
- Every new executable module introduced by this change has greater than 90%
  line and branch coverage, measured per module rather than diluted by an
  aggregate repository percentage.

## Verification

- `openspec validate surface-local-program-execution --strict`
- Browser lane: isolated extension fixtures plus `npm run verify`, `npm run
  smoke`, and per-new-module line/branch coverage above 90%.
- Android lane: unit/instrumentation tests against an isolated fixture app,
  `./gradlew test assembleDebug`, and per-new-module line/branch coverage above
  90%.
- macOS lane: isolated test host/fixture account, `swift test`, product build,
  and per-new-module line/branch coverage above 90%.
- Gateway/protocol lane: closed-schema and routing tests plus `npm run check`
  and per-new-module line/branch coverage above 90%.

## Impact

This change adds a shared protocol and surface adapters; it does not itself
grant OS permission, install a client, launch foreground UI, or deploy any
surface. Each implementation lane produces an isolated artifact first. A real
install and TCC/accessibility QA are separate promotion evidence, never implied
by compilation or packaging.
