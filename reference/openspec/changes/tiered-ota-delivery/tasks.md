## 1. Taxonomy And Contract Definition

- [ ] 1.1 Write the version-move contract spec: `list(query)`, `move(version,
      metadata)`, `rollback(version, metadata)` signatures and the shared
      receipt shape (`{ok, layer, from_version, to_version, reason, changed,
      actor}`), keyed against `agent-profile.js`'s existing
      `versions()`/`rollback()`/`revertLast()` return shapes.
      Acceptance: the spec document lists every field name and shows the exact
      `agent-profile.js` field it maps from, with no unmapped field.
- [ ] 1.2 Record the Tier 1 vs. Tier 2 taxonomy rule (revert cost, not
      transport) and the layer registry (agent profile, UI spec, page tweaks,
      companion package, surface skills) as Tier 1; APK/native package
      adapters as Tier 2.
      Acceptance: a reviewer can classify any existing gateway `lib/` module
      touched by this change as Tier 1 or Tier 2 using only the written rule,
      with no ambiguous case in the initial layer registry.

## 2. Shared Version-Move Contract — Reference Implementation

- [ ] 2.1 Extract the version-move contract as a small shared module (or a
      documented duck-typed interface, if extraction adds no real reuse yet)
      and adapt `agent-profile.js` to expose it without changing
      `versions()`/`rollback()`/`revertLast()`'s existing external behavior.
      Acceptance: existing `gateway/lib/agent-profile.js` and
      `profile-control.js` tests pass unchanged; a new test calls the
      contract's `list`/`move`/`rollback` names directly against the profile
      store and gets the same result as the existing named functions.
- [ ] 2.2 Add a rollback-of-a-rollback fixture proving history stays
      append-only and undo is itself undoable through the contract's names.
      Acceptance: three sequential contract calls (edit, rollback, rollback
      the rollback) leave four version records and the current version equal
      to the first edit, verified by a deterministic test.

## 3. Second Layer Adoption — Prove Generalization

- [ ] 3.1 Add an append-only version log to `gateway/lib/ui-spec.js` behind
      the same replace-not-merge validation it already has, and implement the
      version-move contract against it.
      Acceptance: a rejected `PUT` still leaves the prior spec active (no
      regression to existing behavior) and a valid `PUT` followed by a
      contract `rollback` restores the immediately prior spec document,
      verified by a deterministic test.
- [ ] 3.2 Document why `page-tweaks.js`, `companion-package.js`, and
      `surface-skills.js` are deferred to section 6 rather than onboarded now
      (each currently lacks a server-side version store).
      Acceptance: the note names the exact missing piece per layer (store,
      not validator) so section 6 tickets are not blocked on rediscovery.

## 4. Channel Model

- [ ] 4.1 Add the `nightly` channel value alongside existing Tier 2 channel
      values wherever `release-registry.js`'s `channel` field is consumed,
      with `stable` remaining the default for clients that do not opt in.
      Acceptance: a fixture proves an unset/absent channel preference
      resolves to `stable` on both tiers, and an explicit `nightly` request
      resolves only releases published on `nightly`.
- [ ] 4.2 Confirm `release-registry.js`'s `channel` validation
      (`cleanId`) accepts `nightly` with no code change required; add a
      regression test pinning that fact so a future validation tightening
      cannot silently break it.
      Acceptance: the test fails if `nightly` is ever rejected by
      `cleanId`-based channel validation.

## 5. Agent Tool Binding

- [ ] 5.1 Add the Tier 1 `layer_version_move`-style tool (name finalized in
      implementation), scoped to the layers onboarded in sections 2-3, routed
      through the existing tool-sanitizer and approval path with no new
      execution surface.
      Acceptance: a tool call with a `layer` value outside the registered
      Tier 1 set is rejected before reaching any layer store.
- [ ] 5.2 Add the deterministic "go back" resolution fixture: a natural-
      language instruction resolves to a Tier 1 tool call for a registered
      layer, and an equivalent instruction naming the application/APK version
      resolves to the separate Tier 2 tool/flow, never the reverse.
      Acceptance: both directions of the fixture pass, and no single
      parameter value can move a Tier 1 tool call into Tier 2 behavior.
- [ ] 5.3 Add a spoken receipt: after a Tier 1 move, the reply names the layer
      and the version moved to/from, consistent with how `revertLast()`
      already returns a descriptor callers can speak.
      Acceptance: one phone or gateway-simulated voice turn triggers a Tier 1
      rollback and the spoken/text reply names the correct layer and version
      without exposing internal version-id formatting.

## 6. Remaining Layer Onboarding

- [ ] 6.1 Add a server-side version store to `page-tweaks.js` (or its
      persistence layer, wherever tweak records are kept) and implement the
      version-move contract against it.
      Acceptance: a contract `rollback` reverts the browser to the previous
      tweak record and a real browser-extension smoke confirms the reverted
      page state.
- [ ] 6.2 Add server-side version history to `companion-package.js` and
      implement the version-move contract against it.
      Acceptance: a contract `list` returns prior companion package versions
      by semver, and `rollback` restores a prior manifest+receipt pair
      byte-identical to what was originally installed.
- [ ] 6.3 Add version history to `surface-skills.js`'s per-surface skill
      bundle resolution and implement the version-move contract against it.
      Acceptance: a contract `rollback` restores the prior skill bundle for
      one surface without affecting the other surface's current bundle.
- [ ] 6.4 Extend the Tier 1 tool binding's registered layer set (task 5.1) to
      include each layer onboarded in this section as it lands.
      Acceptance: the "go back" fixture from 5.2 passes for each newly
      registered layer with no change to its resolution logic.

## 7. Tier 2 Pre-Release Gate For Hard-To-Revert Changes

- [ ] 7.1 Add a recorded, auditable flag on Tier 2 release metadata marking a
      release as hard to revert without uninstall/reinstall (schema-
      incompatible data, breaking storage migration, signing-identity
      change), with the flag decision and rationale stored, not just implied.
      Acceptance: a release cannot advance past `built`/`packaged` with the
      flag set until the extra evidence in 7.2 is attached; an unflagged
      release is unaffected.
- [ ] 7.2 Require the full package/install/relaunch/rollback QA evidence
      `cross-surface-update-delivery`'s task list already defines before a
      flagged release's channel head can advance.
      Acceptance: a fixture blocks channel-head advancement for a flagged
      release missing any one piece of that evidence, and allows it once all
      pieces are present.
- [ ] 7.3 Confirm the existing `MoaUpdatePolicy`/`MoaUpdateNotifier`
      consent-first client flow is unchanged by this section (no new client
      behavior required, only a gateway-side gate before publication).
      Acceptance: existing `MoaUpdatePolicyTest.java` passes unchanged.

## 8. Documentation And Final Verification

- [ ] 8.1 Update `ARCHITECTURE.md` with the Tier 1/Tier 2 taxonomy, the
      version-move contract, the `stable`/`nightly` channel model, and the
      layer registry, once sections 2-5 are live.
      Acceptance: documented ownership matches shipped code; no layer is
      described as contract-adopted before its section lands.
- [ ] 8.2 Cross-reference `cross-surface-update-delivery`'s
      `release-rollback-and-receipts` capability to this change's Tier 1
      contract instead of leaving the two undocumented as separate systems.
      Acceptance: both spec documents point at each other and describe the
      same tier boundary with no contradiction.
- [ ] 8.3 Run strict OpenSpec validation for this change.
- [ ] 8.4 Run `cd gateway && npm run check` and the new contract/tool-binding
      fixtures from sections 2, 4, and 5.
- [ ] 8.5 Run `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk"
      ./gradlew assembleDebug`, then one phone QA pass confirming a Tier 1
      voice rollback does not trigger the Tier 2 update notifier.
- [ ] 8.6 Commit each coherent section with a Conventional Commit and follow
      the repository's Finish Order (verify, commit, preview/artifact,
      active-promotion gate, smoke) for every deployable surface touched.
