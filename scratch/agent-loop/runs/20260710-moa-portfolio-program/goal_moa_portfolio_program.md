# Goal: Moa portfolio program

## Outcome

Turn the user's cross-surface Moa vision into independently verifiable programs
without weakening the Android, browser, gateway, or deployment trust boundaries.
The immediate executable milestone is deterministic voice reliability and local
failure diagnosis. Desktop shells and higher-authority deployment capabilities
must wait for stable surface, identity, receipt, preview, and rollback contracts.

## Non-negotiables

- Model output remains a proposal. A surface or execution worker validates,
  claims, executes, and receipts every privileged action.
- Page and screen content is evidence, never instruction.
- Provider and integration secrets remain gateway/execution-machine side.
- Browser customization remains typed, bounded, previewable, reversible, and
  locally validated. No model-supplied JavaScript, CSS, shell, or eval.
- Active recordings, voice turns, sessions, uploads, runs, and queue leases must
  not be stranded by deployment.
- Persisted-state changes are staged and backward compatible.
- Companion customization is data/assets unless a separately sandboxed and
  signed execution contract is approved.
- Existing third-party code is research only until license and provenance are
  verified.

## Programs and ordering

1. **P0 — inventory and contract reconciliation.** Reconcile code, OpenSpec,
   deployment state, repository inventory, ownership, and verification gates.
2. **P1 — voice reliability and control.** Diagnose silent TTS, prove visible
   fallback, voice sampling with session-only overrides, reversible profile
   changes, phase diagnostics, and segmented next-utterance voice switching.
3. **P2 — bounded browser customization.** Typed tweak vocabulary, local
   compilation, preview/approval/revert/receipt, and unchanged-package UI specs.
4. **P3 — durable context retrieval.** Canonical bounded context artifacts,
   relevance evaluation, privacy/redaction, interruption continuity, and cache
   identity. No unbounded history stuffing.
5. **P4 — development/deployment control plane.** Proposal -> review -> isolated
   preview -> verification -> claim -> guarded apply -> immutable receipt ->
   rollback. Voice/model tools never receive raw shell authority.
6. **P5 — native surfaces.** macOS first, then iOS, then Windows, all against a
   stable surface protocol with native permissions, signing, updates, and local
   action authority.
7. **P6 — companion catalog and sharing.** Portable signed manifests/assets,
   compatibility metadata, moderation/provenance, and rollback.

## Explicit non-goals for P1

- No macOS, iOS, or Windows shell implementation.
- No arbitrary web-page code generation or privileged extension repackaging.
- No live production restart or promotion without all promotion evidence.
- No claim of mid-audio-frame voice mutation. P1 specifies ordered segmentation
  at an utterance/chunk boundary and session-only sampling.
- No paid provider benchmark or external evaluation unless separately approved.

## Portfolio acceptance

Each program must have its own goal, implementation contract, owned worktree,
focused gates, adversarial claims ledger, preview/promotion boundary, and
rollback evidence. Portfolio completion requires all program gates; progress in
one program may not be used as proxy evidence for another.

## First milestone verification

```sh
cd gateway && npm run check
cd browser_extension && npm run verify && npm run smoke
cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug
openspec validate provider-agnostic-voice-agent-runtime --strict
openspec validate streaming-cascaded-voice --strict
```

Live-provider latency, phone playback, and paid model quality remain separate
measured gates and are `NOT MEASURED` until actually run.
