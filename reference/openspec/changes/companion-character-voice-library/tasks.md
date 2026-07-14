## 1. Character Manifest v2

- [x] 1.1 Extend the sanitized pet spec with `persona`, `voice_profile`,
      `provenance`, and `command_verbs`; keep old manifests loading unchanged.
- [x] 1.2 Round-trip smoke: v1 manifest loads, v2 fields survive
      list/create/preview/apply.

## 2. Cloned-Voice Pipeline

- [x] 2.1 Add `/v1/agent/pets/:id/voice-clone` job endpoint (upload or
      approved-URL reference audio) writing a `voice_binding.custom_voice`
      enrollment record with consent metadata.
- [x] 2.2 Dry-run mode while the Google cloning allowlist is pending: validate
      inputs, store the plan, bind the closest canonical voice as fallback.
- [ ] 2.3 Record the allowlist request status as a promotion blocker note.

## 3. Character Discovery Worker

- [ ] 3.1 Agent-run job: query -> ranked character candidates -> draft
      manifests with reference links into a review queue (never auto-publish).
- [ ] 3.2 Review UI/CLI to approve, edit, or reject drafts; approval triggers
      sprite generation + voice binding.

## 4. Command-Driven Animation

- [x] 4.1 Expose the pet motion runtime as a `companion_motion` agent tool with
      validated motion plans (verbs + targets), proposal-only authority.
- [x] 4.2 Wire the tool through the cascaded voice tool loop so "walk to the
      corner" works in a spoken turn on the `/pets/` surface.

## 5. Builder + Shared Library

- [x] 5.1 `/pets/` "describe it" flow: one prompt -> manifest + sprites +
      persona + voice suggestion, manual controls as refinement.
- [x] 5.2 `visibility: local|shared`, publish/list/install endpoints, install
      = profile patch; publish requires review.

## 6. Verification

- [x] 6.1 Gateway `npm run check` + new smokes (clone dry-run, manifest v2,
      motion-tool validation).
- [ ] 6.2 Live QA: one spoken turn as an installed character with bound voice.
