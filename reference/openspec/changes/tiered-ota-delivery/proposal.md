## Why

Moa already ships two kinds of change: a rebuilt native package (the Android
APK, with browser/macOS/Windows package adapters defined in
`cross-surface-update-delivery`) and a set of gateway-served data layers the
installed app reads at runtime (agent profile, UI spec, page tweaks, companion
packages, per-surface skills). Today only the native tier has a rollback
story: `gateway/lib/android-ota.js` (landed on the `lane/ota-gateway-20260713`
branch, not yet merged to this checkout) serves a versioned release store with
a `current` symlink and a consent-first client policy
(`android_app/.../MoaUpdatePolicy.java`, `MoaUpdateNotifier.java`) that treats
uninstall-first restore as an escape hatch, not the everyday path. The data
layers have per-module versioning (`gateway/lib/agent-profile.js` already
appends an immutable version per edit and exposes `rollback()` and
`revertLast()`) but no shared contract, no uniform way to list/move/roll back
a layer's version, and no agent-invocable tool surface. A spoken "go back to
how you behaved yesterday" only works today for the agent profile, and only
through `POST /v1/agent/profile/rollback` called by hand.

The user's direction (2026-07-14) inverts which tier is the primary ship
vehicle. The APK should update rarely, be tested hard before every release,
and generally not need a downgrade path. The day-to-day product surface --
config, prompts, profiles, UI specs, page tweaks, capability/skill bundles,
companion packages, and other "executives the application runs" -- should
ship as OTA-updatable dynamic layers that move independently of the APK, and
the user's own agent should be able to move a layer's version on the user's
behalf, in response to a spoken instruction, without touching the installed
package.

This change defines the two-tier taxonomy, a channel model per tier, one
version-move contract every dynamic layer implements, and the safety rules
that let an agent invoke that contract as a tool while a native-package
downgrade stays a deliberate, consent-first, tier-2-only action.

## What Changes

- Define **Tier 1 (dynamic layers)**: gateway-served, OTA-updatable data the
  installed app executes without a package update -- agent profile (system
  prompt, persona, tool policy, voice), UI spec (`ui-spec.js`), page tweaks
  (`page-tweaks.js`), companion packages (`companion-package.js`), and
  per-surface skill/capability bundles (`surface-skills.js`). Tier 1 is data
  and declarative records only, consumed by code already shipped in the
  package; it is never remotely executed script or bytecode.
- Define **Tier 2 (native package)**: the Android APK today, with the browser/
  macOS/Windows adapters `cross-surface-update-delivery` defines. Tier 2
  releases are infrequent, carry the full verification/signing/staged-rollout
  weight already specified there, and are designed so a downgrade is rarely
  needed. The just-shipped `android-ota.js` versioned release store and
  consent-first `MoaUpdatePolicy`/`MoaUpdateNotifier` client flow remain the
  tier-2 escape hatch, gated behind extra scrutiny (see Safety Rules), not the
  routine update mechanism.
- Add a **channel model per tier**: `stable` and `nightly`, reusing
  `release-registry.js`'s existing free-form `channel` field (it already
  accepts any `cleanId`-valid string; this change does not introduce a second
  channel taxonomy). `nightly` is the fast-moving, opt-in channel for both
  tiers -- nightly APK builds keep existing today's cadence expectations,
  nightly dynamic-layer publishes can happen many times a day. `stable` is the
  default channel every installed client resolves to.
- Add a **uniform version-move contract**: `list`, `move` (aka activate/
  publish), and `rollback`, implemented once and adopted by every Tier 1
  layer store, modeled directly on `agent-profile.js`'s existing
  `versions()` / `rollback(version)` / `revertLast()` shape. Each layer keeps
  its own storage and validation (profile fields, UI spec schema, companion
  manifest, skill bundle); the contract standardizes only the list/move/
  rollback surface, the version identifier shape, and the receipt record.
- Expose the version-move contract as **agent-invocable tools**, scoped per
  layer, so a spoken instruction like "go back to how you behaved yesterday"
  or "undo that page change" resolves to a Tier 1 version move -- never a
  Tier 2 APK reinstall -- unless the user is explicitly talking about the app
  version itself.
- Require **consent and a receipt** for every version move: Tier 1 moves are
  reversible-by-construction (append-only version history, `revertLast`
  undoes an undo) and get a lightweight confirmation; Tier 2 moves keep the
  full consent-first flow `MoaUpdatePolicy`/`MoaUpdateNotifier` already
  implement, plus the extra pre-release testing gate this change adds for any
  Tier 2 change that is hard to revert without uninstall/reinstall.
- Note `release-registry.js` as the shared home for cross-layer release
  eligibility/channel-selection logic if/when Tier 1 layers need staged
  rollout or cohorting; this change does not require every layer to adopt it
  immediately, only that a layer needing rollout logic reuse it instead of
  inventing a second evaluator.

## Capabilities

### New Capabilities

- `dynamic-layer-version-move-contract`: the shared list/move/rollback
  interface, version identifier shape, and receipt record every Tier 1 layer
  store implements.
- `agent-invocable-layer-rollback`: the tool-surfaced binding from a spoken or
  typed instruction to a version-move call, including the mapping rule that
  keeps "go back to X" resolving to a Tier 1 move rather than a Tier 2
  reinstall.
- `tiered-release-channel-model`: the `stable`/`nightly` channel definition
  per tier and the extra pre-release testing gate for hard-to-revert Tier 2
  changes.

### Modified Capabilities

- `release-rollback-and-receipts` (from `cross-surface-update-delivery`):
  clarified as the Tier 2 rollback path specifically, with the version-move
  contract above as the Tier 1 counterpart it does not replace.

## Boundaries

- A Tier 1 layer is data: config, prompts, profile fields, a UI spec
  document, a page-tweak record, a companion manifest, or a skill bundle
  descriptor. It is consumed by executor/renderer code already shipped in the
  installed package. This change adds no new remote-code-execution surface;
  code-mode execution stays inside the existing sandboxed executor
  (`executor.sh` / QuickJS) gated by `VOICE_EXECUTE_TOOL`, unchanged by this
  proposal.
- Model/server output remains a proposal, not an executable instruction: a
  version-move tool call still goes through the same tool-sanitizer and
  approval path every other tool call uses. The agent can request a rollback;
  it does not get to bypass the receipt or consent step for a Tier 2 move.
- Tier 2 stays the only path that replaces the installed package. This change
  does not shrink Tier 2's testing bar; it adds an explicit extra gate for
  Tier 2 changes that are hard to revert without uninstall/reinstall, on top
  of (not instead of) the verification `cross-surface-update-delivery`
  already defines.
- The channel model reuses the existing `release-registry.js` field; this
  change does not add a third channel value, a per-user channel override
  mechanism, or staged-rollout percentages beyond what `release-registry.js`
  and `android-ota.js` already carry.
- Master Orch (`~/projs/master-orch`) remains the control plane for the
  repository's own preview/deploy/rollback lifecycle (worktrees, deployment
  markers, rollback-to-previous-artifact). It is not itself a Tier 1 layer
  store; this change treats it as prior art for "list versions, move, roll
  back" as a uniform contract, not as code this change modifies.

## Current Truth At Change Creation

| Seam | Evidence present on 2026-07-14 | Not established by this evidence |
|---|---|---|
| `gateway/lib/agent-profile.js` | Append-only version history, `versions()`, `rollback(version)`, `revertLast()`, device-scope overrides | A contract other layers implement; no shared list/move/rollback interface name |
| `gateway/lib/release-registry.js` | Immutable release schema, generic `channel` field, eligibility/rollout evaluator | Applied to any Tier 1 layer; today only referenced by the Tier 2 Android OTA store |
| `gateway/lib/android-ota.js` | Versioned release store, `current` symlink, rollback manifest field (on `lane/ota-gateway-20260713`, not yet merged here) | Extra pre-release gate for hard-to-revert changes; agent-invocable tool binding |
| `android_app/.../MoaUpdatePolicy.java`, `MoaUpdateNotifier.java` | Consent-first update decision policy and notifier (untracked/new on this branch) | Wired to the Tier 1/Tier 2 distinction this change names |
| `gateway/lib/ui-spec.js`, `page-tweaks.js`, `companion-package.js`, `surface-skills.js` | Per-layer validation and, for `ui-spec.js`/`companion-package.js`, versioned/manifest schemas | A shared list/move/rollback surface; agent tool bindings |
| `~/projs/master-orch` | Deployment state, artifact/ref rollback for the repo's own control plane | A Tier 1 layer store itself; not modified by this change |

The table is a baseline, not a production claim. Task completion must attach
the observable evidence named in `tasks.md`.

## Impact

- New shared version-move contract module (exact location decided in
  `design.md`) and adoption by `agent-profile.js` (already shaped for it),
  `ui-spec.js`, `page-tweaks.js`, `companion-package.js`, and
  `surface-skills.js`.
- New agent tool bindings (list/move/rollback per layer) added to the existing
  tool-sanitizer and approval path; no new execution surface.
- `android-ota.js` and the Android consent-first update client are reframed as
  the Tier 2 escape hatch with an added pre-release gate for hard-to-revert
  changes; no behavior change to the already-shipped rollback mechanics.
- `ARCHITECTURE.md` gains the Tier 1/Tier 2 taxonomy and channel model once
  implementation lands.
- `cross-surface-update-delivery`'s `release-rollback-and-receipts` capability
  gains a cross-reference to this change's Tier 1 contract instead of being
  duplicated.

## Verification

- Strict OpenSpec validation for this change.
- Deterministic fixtures proving the shared version-move contract's list/move/
  rollback behavior against at least two Tier 1 layer stores (agent profile
  plus one other), including a rollback-of-a-rollback case.
- Deterministic fixtures proving the agent-invocable tool binding resolves a
  "go back" instruction to a Tier 1 move and refuses to map it to a Tier 2
  reinstall.
- Gateway: `cd gateway && npm run check`.
- Android: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk"
  ./gradlew assembleDebug`, plus one phone QA pass confirming a Tier 1 voice
  rollback does not trigger the Tier 2 update notifier.
