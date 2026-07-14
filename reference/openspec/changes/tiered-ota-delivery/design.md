## Context

Two update mechanisms already exist independently:

- `gateway/lib/agent-profile.js` is a runtime-editable, versioned profile.
  Every edit appends a new version (`appendVersion`); `versions()` lists them,
  `rollback(version)` re-applies a named version as a new version (history
  stays append-only), and `revertLast()` re-applies the immediately prior
  version -- an undo that is itself undoable. `gateway/lib/profile-control.js`
  exposes this over `POST /v1/agent/profile/rollback` behind
  `authorizedAgent`.
- `gateway/lib/android-ota.js` (on `lane/ota-gateway-20260713`) is a versioned
  APK release store: `releases/<release_id>/` holds the artifact plus
  `release.json`, an atomic `current` symlink names the active release, and
  the served manifest reports a `rollback` target when an older previously-
  published release exists. `android_app/.../MoaUpdatePolicy.java` is a pure
  decision function (`CURRENT` / `AVAILABLE` / `DEFERRED` / `INVALID`) the
  client evaluates before ever prompting the user, and
  `MoaUpdateNotifier.java` is the consent-first UX around it.

These two mechanisms solve the same underlying problem -- list versions of a
thing, move to one, roll back -- for two very different weight classes of
change. `gateway/lib/ui-spec.js`, `page-tweaks.js`, `companion-package.js`,
and `surface-skills.js` are three more things a user or agent might want to
list/move/roll back, and today none of them has any version history at all:
`ui-spec.js` stores one current document (replace-not-merge, validated so a
bad `PUT` cannot blank the surface, but no history); `page-tweaks.js` is a
stateless per-record validator with no store; `companion-package.js` has a
manifest schema and semver field but no server-side version list;
`surface-skills.js` routes per-surface skill offerings with no persisted
version concept at all.

`gateway/lib/release-registry.js` already generalizes one piece of this: an
immutable release schema, a signed-channel-head concept, and a `channel` field
that is a free-form validated string (`cleanId`), not a fixed enum. It is
currently wired only to the Tier 2 Android OTA path. `cross-surface-update-
delivery` (2026-07-13) already defines the Tier 2 cross-platform release
envelope, channels (`stable`/`beta`/`development`), staged rollout, and
rollback for the native package across Android/browser/macOS/Windows. This
change does not redo that work; it names the Tier 1 counterpart and the
uniform contract that lets an agent move either tier's version through one
tool shape, while keeping the tiers' safety bars different on purpose.

## Goals / Non-Goals

**Goals:**

- Name a two-tier taxonomy (dynamic layers vs. native package) that matches
  what is already shipped, not a new architecture: Tier 1 is "data the
  installed app already knows how to execute," Tier 2 is "the installed app
  itself."
- Define one version-move contract (list/move/rollback) that every Tier 1
  layer store implements, shaped after `agent-profile.js`'s existing
  `versions()`/`rollback()`/`revertLast()` because that is the one layer that
  already has real, tested version history.
- Make the contract agent-invocable as tools, so a spoken "go back to how you
  behaved yesterday" resolves deterministically to a Tier 1 move with no
  ambiguity about which layer or which tier.
- Keep Tier 2 exactly as safety-gated as `cross-surface-update-delivery` and
  the just-shipped `android-ota.js`/`MoaUpdatePolicy` already made it; add
  only an explicit extra pre-release testing gate for Tier 2 changes that are
  hard to revert without uninstall/reinstall.
- Reuse `release-registry.js`'s channel field for `stable`/`nightly` instead
  of inventing a parallel channel concept.

**Non-Goals:**

- No remote code execution beyond the already-sandboxed executor
  (`executor.sh` / QuickJS, gated by `VOICE_EXECUTE_TOOL`). Tier 1 layers are
  data records validated by code already in the package; this change adds no
  new interpreter, script host, or dynamic-dispatch surface.
- No change to `cross-surface-update-delivery`'s Tier 2 release envelope,
  signing, staged rollout, or platform adapters. This change references that
  contract and adds a testing-gate note; it does not re-specify it.
- No decision here about which storage backend (`release-registry.js` reuse
  vs. a lighter per-layer store) every Tier 1 layer uses long-term --
  `agent-profile.js` already has its own working version store and does not
  need to migrate onto `release-registry.js` to satisfy the shared contract;
  the contract is an interface, not a mandated storage engine.
- No new channel values beyond `stable`/`nightly`. A per-user or per-cohort
  rollout percentage for Tier 1 layers is out of scope; if a layer later needs
  staged rollout it adopts `release-registry.js`'s existing evaluator rather
  than this change defining a second one.
- No UI for browsing layer version history in this change; the contract and
  its tool bindings are the deliverable, a settings-screen history view is a
  follow-up.

## Decisions

### Decision: two tiers, defined by revert cost, not by transport

Tier 1 (dynamic layer) and Tier 2 (native package) are distinguished by one
question: can this change be undone by writing a new version record, or does
undoing it require replacing the installed binary? Everything that can be
undone by appending a new version -- agent profile fields, a UI spec document,
a page-tweak record, a companion package manifest, a surface-skill bundle --
is Tier 1 regardless of how it is delivered. The APK itself, and any future
macOS/Windows/browser-store package `cross-surface-update-delivery` covers, is
Tier 2 because undoing it means installing a different binary.

Alternative considered: tier by delivery mechanism (anything served over HTTP
vs. anything requiring a package manager). Rejected: `android-ota.js` already
serves the APK over HTTP with the same kind of versioned-store shape as a
Tier 1 layer would use; delivery mechanism does not track revert cost, and
revert cost is what actually drives the different safety bars.

### Decision: the version-move contract is `list(query) -> versions[]`, `move(version, metadata) -> receipt`, `rollback(version, metadata) -> receipt`, modeled on `agent-profile.js`

`agent-profile.js` already has the shape: `versions({limit, deviceId})` lists,
`rollback(version, metadata)` re-applies a named version as a new version, and
`revertLast(metadata)` is sugar for "move to the version immediately before
the current one." The contract generalizes this to any layer:

- `list(query)` returns an ordered array of `{version, created_at, source,
  reason, parent_version, rollback_from_version, changed}` records -- the same
  fields `agent-profile.js` already returns from `versions()`, so adopting the
  contract does not change that module's public shape, only names it as the
  reference implementation.
- `move(version, metadata)` activates a specific existing version as current.
  For `agent-profile.js` this is `rollback(version, metadata)` under a shared
  name (the existing function already does exactly "move to version X," the
  name "rollback" undersells the forward-move case).
- `rollback(version, metadata)` is `move` restricted to a version older than
  current, matching `revertLast()`'s "undo is itself undoable" guarantee:
  calling `rollback` never deletes history, it always appends a new version
  that happens to equal an older one.
- Every call returns a receipt: `{ok, layer, from_version, to_version,
  reason, changed, actor}`, mirroring `revertLast()`'s existing return shape
  (`ok`, `reason`, `scope`, `reverted_to_version`, `from_version`,
  `to_version`, `changed`, `profile`) generalized past the profile-specific
  fields.

Layers that currently have no version history (`ui-spec.js`, `page-tweaks.js`
as a store, `companion-package.js`'s server-side history, `surface-skills.js`)
gain an append-only version log the same way `agent-profile.js` already has
one; they do not need to change their own validation logic, only wrap it in
the same append-on-write pattern.

Alternative considered: give each layer its own bespoke rollback endpoint
(as `agent-profile.js`/`profile-control.js` and `android-ota.js` do today,
independently). Rejected: that is the status quo, and it is exactly why "go
back to yesterday" only works for one layer today -- every new layer would
need its own hand-wired agent tool, its own receipt shape, and its own
list endpoint, none of which composes.

### Decision: the tool surface maps intent to layer, and defaults away from Tier 2

An agent-invocable `layer_version_move` (name TBD in implementation) tool
takes `{layer, version | "previous", reason}` and calls the shared contract
for that layer. A natural-language instruction like "go back to how you
behaved yesterday" or "undo that page change" resolves through the model's
existing tool-selection to a `layer` value, not directly to a raw endpoint;
the tool's own scoping restricts `layer` to the registered Tier 1 layer names
and explicitly excludes the Tier 2 package version. A user asking to move the
*application version itself* ("go back to the old version of the app") is a
distinct, separately named Tier 2 tool/flow that inherits
`MoaUpdatePolicy`'s consent-first gate; the two tools are never the same tool
with a tier flag, so a model cannot accidentally widen a Tier 1 request into
a Tier 2 reinstall by picking the wrong parameter value.

Alternative considered: one tool with a `tier` parameter covering both. 
Rejected: collapsing them into one tool makes a wrong parameter value (model
error or adversarial prompt content misread as instruction) capable of
triggering an uninstall-class action from what should be a reversible data
move; two distinctly named tools with different consent requirements is a
stronger boundary than a runtime branch inside one tool.

### Decision: consent scales with revert cost, not with tier alone

Tier 1 moves are receipted (every move is recorded, listable, and undoable by
construction) but do not require the same blocking user confirmation Tier 2
does, because the cost of being wrong is "one more appended version," not
"replace the running binary." Tier 2 keeps the full `MoaUpdatePolicy`/
`MoaUpdateNotifier` consent-first flow already shipped, and this change adds
one more gate on top: a Tier 2 change flagged as hard to revert without
uninstall/reinstall (schema-incompatible profile data, a breaking storage
migration, a signing-identity change) requires the extra testing evidence
`cross-surface-update-delivery`'s task list already calls for
(package/install/relaunch/rollback QA on the real target) before it can even
reach a channel head, not just before install.

Alternative considered: require the same confirmation dialog for both tiers.
Rejected: that would make the everyday dynamic-layer path -- the one this
change exists to make routine -- feel as heavy as an app reinstall, defeating
the goal of making Tier 1 the normal ship vehicle.

### Decision: `stable`/`nightly` reuses `release-registry.js`'s existing channel field

`release-registry.js`'s `channel` is `cleanId(input.channel, "channel")`, a
generic validated string, not a fixed enum in code. `cross-surface-update-
delivery`'s proposal describes `stable`/`beta`/`development` as its Tier 2
channel set. This change adds `nightly` as the Tier 1 fast channel and reuses
`stable` as the default resolution for both tiers, rather than introducing a
second, incompatible channel vocabulary. Tier 2's `beta`/`development`
channels are unaffected; a future consolidation could alias `development` and
`nightly` if that turns out to be the same audience, but this change does not
require that decision now.

Alternative considered: a fully separate Tier 1 channel enum
(`layer-stable`/`layer-nightly`). Rejected: `release-registry.js` places no
constraint requiring tier-specific prefixes, and a shared vocabulary keeps one
mental model for "which channel is this on" across both tiers.

## Risks / Trade-offs

- A shared version-move contract could tempt every layer to converge on
  `release-registry.js`'s heavier immutable-release schema even where it does
  not fit (e.g. `agent-profile.js`'s per-turn append pattern) -> mitigated by
  stating explicitly that the contract is an interface, and `agent-profile.js`
  keeps its own store as the reference implementation.
- Two similarly-named tools (Tier 1 layer move vs. Tier 2 package move) risk
  the model picking the wrong one on ambiguous phrasing -> mitigated by
  distinct tool names/schemas and a deterministic fixture proving a "go back"
  phrasing resolves to Tier 1, not Tier 2, before this ships.
- Layers with no history today (`ui-spec.js`, `page-tweaks.js`,
  `companion-package.js`, `surface-skills.js`) need a storage change to gain
  an append-only log -> scoped as separate, sequenced tasks per layer in
  `tasks.md` rather than one big-bang migration.
- Widening what counts as "hard to revert" for Tier 2 is a judgment call that
  could be gamed by under-flagging a risky change -> mitigated by requiring
  the flag decision and its rationale to be recorded in the release metadata
  itself (auditable), not left to an unrecorded operator judgment.

## Migration Plan

1. Land the shared version-move contract (interface + receipt shape) as a
   small module, with `agent-profile.js` adopted first since it already has
   the closest-matching implementation -- this proves the contract against
   real history before any other layer touches it.
2. Adopt the contract in one additional Tier 1 layer (`ui-spec.js` is the
   next-best fit: it already validates a whole-document replace) to prove the
   contract generalizes past the profile-specific case.
3. Add the agent-invocable Tier 1 tool binding, scoped to the layers onboarded
   in steps 1-2, with the deterministic "go back" resolution fixture.
4. Add the `nightly` channel value alongside existing Tier 2 channels in
   `release-registry.js` consumers, with no change to `stable` resolution
   behavior for clients that do not opt in.
5. Add the extra pre-release testing-gate flag to the Tier 2 release metadata
   and require it before a hard-to-revert release can advance past `built`/
   `packaged`, reusing `cross-surface-update-delivery`'s existing evidence
   states rather than inventing new ones.
6. Onboard the remaining Tier 1 layers (`page-tweaks.js` store,
   `companion-package.js` server-side history, `surface-skills.js`) once the
   contract has shipped against two real layers and the tool binding has real
   usage evidence.
7. Update `ARCHITECTURE.md` with the two-tier taxonomy and channel model once
   steps 1-3 are live.

## Open Questions

- Should `page-tweaks.js` gain a server-side store at all, or should
  per-tweak "undo" stay a client-local browser-extension concern (it currently
  has no persistence layer to version)? Left for the task that onboards it.
- Should the extra Tier 2 pre-release gate be a manual reviewer flag or a
  heuristic (e.g. schema-diff detection) that proposes the flag for a human to
  confirm? Left as a manual, recorded flag for this change; automation is a
  follow-up once enough hard-to-revert releases exist to find a pattern.
- Does `nightly` eventually replace `cross-surface-update-delivery`'s
  `development` channel name for Tier 2, or do they stay distinct audiences?
  Left open; this change only adds `nightly` for Tier 1 and does not rename
  Tier 2's existing channels.
