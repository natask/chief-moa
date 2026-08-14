# Acceptance Demo

## Preconditions

- Two test accounts and devices are enrolled with revocable scoped credentials.
- Stable S1 is installed, activated, smoked, and retained with its predecessor.
- Conversation, development, and release stores enforce tenant/user/device
  ownership.
- The native rescue screen has cached signed stable metadata.

## Demo

1. Break voice authentication, then speak: “Fix the voice token issue and add
   release rescue.” Confirm the partial transcript is retained and the app
   offers text, retry, reconnect, and rescue actions.
2. Send the retained draft after reconnecting. Confirm exactly one named request
   exists despite retrying the original voice action.
3. Open Work. Inspect the proposed plan before starting it. Confirm it reports
   six tasks, three runnable agents, dependencies, path claims, integration, QA,
   and acceptance checks.
4. Start the plan. Confirm three disjoint tasks run together while shared-path
   and dependent tasks wait. Confirm the phone does not receive harness,
   working-directory, worker, or publisher authority.
5. Submit a second named request. Confirm both cards remain separately
   navigable, steerable, and cancelable.
6. Finish the first request. Confirm the feature release records exact source
   commit, artifact digest, tests, verifier, and request ID.
7. Tap `Test this feature`. Confirm Stable and Trial heads do not move, the
   device receives an exact assignment, and selected/install/activate/smoke are
   separate visible states.
8. Submit feedback against the running digest. Confirm it creates a named
   revision proposal but launches nothing until explicitly started.
9. Finish Feature B and choose `Build trial from selected` for A+B. Inject a
   shared-file conflict. Show serialized integration, the proposed resolution,
   preserved behaviors, and rerun checks.
10. Publish and install the composed Trial T2. Confirm its lineage names A, B,
    stable base S1, prior trial T1, integrated commit, and exact artifact bytes.
    The second device remains on Stable S1.
11. Tap `Undo trial`. Confirm the assignment returns to exact predecessor T1
    through a forward-versioned, continuity-signed artifact without uninstall
    or local-data loss. Stable remains S1.
12. Reinstall T2 and request `Promote trial to stable`. First omit one required
    evidence class and confirm promotion fails closed.
13. Supply exact preview smoke, compatibility, drain/resume, rollback,
    backup/restore, and artifact evidence. Confirm recent owner approval and a
    distinct promoter move Stable from S1 to exact T2 bytes.
14. Open history. Confirm the immutable proposal, decision, evidence, before/
    after heads, actor identities, and rollback target.
15. Break conversation auth and model routing again. Open native release rescue
    and restore the confirmed predecessor as a higher-version recovery artifact.
    Confirm rescue cannot chat, run agents, publish, promote, or change a global
    head.
16. With Account B, attempt to read Account A's conversations, requests,
    artifacts, events, and assignments by guessed IDs. Confirm all fail 404/403.
    Revoke Account A's device and confirm its HTTP and voice WebSocket access
    end while Account B remains unaffected.

## Evidence To Capture

- Request/plan/run/integration/verification event IDs and actor identities.
- Exact source commits, candidate bundle IDs, APK digests, signer, and version
  codes.
- Assignment/install/activation/smoke/acceptance/promotion/undo receipts.
- Negative authorization and stale-sequence test output.
- Android screen recording covering voice fallback, Work, Releases, conflict,
  undo, promotion, and native rescue.
- Gateway, release-control, Android, source-size, OpenSpec, preview, promotion,
  and post-promotion smoke receipts.
