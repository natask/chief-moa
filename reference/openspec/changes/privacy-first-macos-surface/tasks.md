## 1. Protocol prerequisite

- [ ] 1.1 Land and smoke the canonical Aggie text-turn/event facade.
- [ ] 1.2 Specify explicit semantic `ui.*` proposal kinds, digest binding,
      stale-state checks, approvals, and receipts before enabling native action.

## 2. Local read-only application

- [ ] 2.1 Scaffold stable signed `MoaMac.app`, pure core/AX packages, and a
      deterministic signed AX fixture app in an isolated worktree.
- [ ] 2.2 Add explicit AX trust UI and the memory-only per-app observation grant.
- [ ] 2.3 Add event-driven bounded snapshotting, secure-field suppression, local
      redaction, visible Pause/Stop scope, and complete revocation.
- [ ] 2.4 Prove 60-second observe/dismiss has no socket/network request and no
      raw AX persistence.

## 3. Explicit release

- [ ] 3.1 Add the exact outbound payload/redaction preview and one-shot digest
      binding to a configured Aggie destination.
- [ ] 3.2 Prove accepted bytes equal previewed bytes; dismissal sends nothing;
      excluded fields never reach a loopback gateway.

## 4. Semantic actions and receipts

- [ ] 4.1 Implement the closed AX capability manifest and local validator.
- [ ] 4.2 Require confirmation and prove success plus stale, expired, mutated,
      wrong-surface, secure-value, and unknown-action rejection in the fixture.
- [ ] 4.3 Write durably committed pending/terminal hash-linked receipts and prove
      crash recovery, replay rejection, and absence of raw labels/values/context.

## 5. Packaging and rollout

- [ ] 5.1 Build/notarize a stable hardened bundle with minimal entitlements and
      a rollback artifact; scan for prohibited frameworks/symbols/SDKs.
- [ ] 5.2 Run isolated-account TCC/privacy/manual QA without touching the user's
      live Accessibility grants or applications.
- [ ] 5.3 Promote only after preview, rollback, compatibility, idle-session, and
      smoke evidence passes.
