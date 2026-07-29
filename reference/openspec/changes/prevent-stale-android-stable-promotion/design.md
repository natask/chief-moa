## Context

Android accepts an APK update when package identity and signer match and its
`versionCode` is higher. It does not understand Git ancestry or product intent.
The current OTA path generates version codes from time, so a late build from an
old branch can overwrite a semantically newer stable build.

## Decision

Represent Android stable as one persistent channel head with:

- application and surface identity;
- immutable release and APK digest;
- Android application id and signer certificate digest;
- source revision and source-policy base revision;
- parent stable release id and source revision;
- globally monotonic channel sequence;
- Android version code;
- exact verification, preview, rollback, compatibility, and smoke evidence;
- promotion actor, policy version, timestamp, and receipt id.

The publisher reads the head, validates the candidate against it, and commits
with the head id and sequence it read. The database transaction locks or
compare-and-swaps that head. Only the winner may update the externally served
stable OTA pointer. A concurrent or stale publisher must reread and reevaluate;
it cannot retry by blindly overwriting the channel.

## Normal stable rule

A normal candidate is eligible only when:

1. its committed source revision is a descendant of the recorded stable source
   revision;
2. its committed source revision is a descendant of the current protected
   source-policy revision (`origin/master` today);
3. it declares the recorded stable release as its parent;
4. its application id, signer, and declared canonical product identity satisfy
   the target channel policy;
5. exact-artifact verification and promotion evidence pass; and
6. the expected stable head and sequence still match at commit time.

The source-policy revision is fetched and pinned before evaluation. A local
tracking ref that has not been refreshed is insufficient evidence.

## Recovery rule

Emergency recovery is a separate release type. It requires a persistent
authorization naming the candidate, exact bytes, reason normal ancestry cannot
be used, current stable head, rollback target, approver, and expiry. It still
requires signer continuity, artifact verification, state compatibility, and an
atomic head transition. A shell flag alone cannot authorize recovery.

## Failure behavior

All validation occurs before stable bytes or pointers change. On ancestry,
identity, evidence, or compare-and-swap failure, stable remains byte-for-byte
unchanged and an immutable rejection receipt records the non-secret reason.
The artifact may remain available as a preview if preview isolation holds.

## Transition

Bootstrap the database head from the exact currently served manifest and APK,
including a verified source revision or an explicit `legacy_unknown` provenance
state. While provenance is unknown, stable publication fails closed until an
owner records a one-time reconciliation with the artifact digest and rollback
evidence. After reconciliation, no worktree-local deploy marker is authoritative.
