# Design: Android Feedback Software Factory V0

## Authority and ownership

`interaction_feedback.v1` remains inert. Android submits `modification_request.v1`
only after the user presses `Create fix` and reviews an
`implementation_authorized` request. The gateway validates the exact feedback,
assignment, bundle, Android release, and APK digest, then idempotently creates:

- one modification request;
- one canonical intent;
- one work-history task;
- one queued worker run; and
- one owner/lease record.

The response returns all identities. Retrying the same device idempotency key
returns the same identities. A conflicting retry fails closed. An accepted
request cannot report `queued` without an owner and run. Lease expiry makes the
request visibly `reclaimable`; it never creates a second concurrent owner.

The coordinator records the base ref and resolved 40-character commit. V0 only
accepts `origin/master`. The worker independently verifies that commit before it
edits and records before, diff, verification, artifact, and preview evidence.

## Routine Android QA

The primary lane runs the real Android application on an Apple-silicon Mac
Android Emulator using a normal Google APIs ARM64 image with hardware rendering.
A hermetic wrapper owns the AVD lifecycle and runs UI Automator scenarios. The
QA-only deterministic injection boundary is unavailable in release builds.

The first scenario covers partial transcript, final transcript, expanded
transcript, History, and Copy. It emits:

- JUnit XML and an interaction trace;
- screenshots and UI hierarchy XML at named checkpoints;
- logcat and `adb screenrecord` MP4; and
- a manifest hashing every evidence file.

The manifest binds source commit, exact continuity-signed APK SHA-256 and signer,
test APK SHA-256, preview namespace, emulator/system-image identity, scenario
revision, and every evidence artifact digest. A verifier fails if bytes change,
a required checkpoint is absent, or the APK/test identities differ.

Firebase Test Lab runs the same test APK against the same application APK as an
independent per-candidate virtual Pixel gate. A small physical Pixel matrix is a
release-candidate gate for hardware-sensitive behavior. Hardware-specific work
retains physical-device acceptance. AWS Device Farm is not the default because
its public flow may re-sign applications.

The VPS stores/co-ordinates jobs and evidence but dispatches Android execution
to a capable runner. Ordinary DigitalOcean droplets are not assumed to expose
KVM or nested virtualization.

## Video feedback foundation

Android may attach an explicitly started, visibly indicated video note to exact
running-release feedback. The app records start/stop/cancel state and a bounded
local artifact descriptor. Upload and submission remain separate, cancellable
steps. The feedback stores a typed ref, byte digest, duration, size, MIME type,
retention policy, and optional time anchors. Video pixels remain evidence and
cannot select a repository or authorize `Create fix`.

V0 may land the capture/state contract before production MediaProjection
capture. No UI may claim a video was captured or uploaded unless the matching
receipt exists.

## Candidate and status

The modification status projection joins request, intent, task, run, QA,
artifact, and preview identities. Android renders the current state and explicit
blocker. The exact candidate becomes selectable only after artifact publication
and matching emulator evidence; assignment never claims installation or smoke.
User acceptance/rejection and stable promotion are later milestones.
