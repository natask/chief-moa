# History-first Android full app

## Product correction

The full app is not an intent portfolio or operations dashboard. The live
overlay is the primary product. The full app opens to searchable/copyable
conversation history; operational controls are secondary.

## Lane tickets

Lane: Android action/accessibility
Outcome: History-first shell with exact copy and explicit Setup & developer.
Files: `MainActivity.java`.
Boundary: no gateway state authority moves onto Android; overlay launch and
assistant invocation stay explicit.
Acceptance: opening the app shows History and does not mutate the overlay.
Verification: Android unit tests, debug assembly, physical-phone QA.
Deploy target: Android OTA.

Lane: Gateway
Outcome: reuse canonical session messages and existing profile/tool/run stores.
Files: none in this slice.
Boundary: foreground/background agent separation remains follow-on work.
Acceptance: existing routes remain compatible.
Verification: no gateway change.
Deploy blocker: not applicable.

Lane: Browser voice and browser action/CDP
Outcome: preserve current behavior; shared redesign follows after Android shell
evidence.
Files: none.
Boundary: browser keeps browser-local authority.
Acceptance: no changed browser artifact.
Verification: not required for this Android-only slice.
Deploy blocker: not applicable.

Lane: Workflow/docs
Outcome: record History-first IA plus the later Activity/Switchboard and
transactional hold/return direction.
Files: Android product-map OpenSpec and architecture.
Boundary: Natstack remains the durable cross-project intent truth; Chief Moa
consumes a projection rather than creating a competing portfolio.
Acceptance: strict OpenSpec validation.
Verification: `openspec validate define-android-core-product-map --strict`.
Deploy target: docs ship with the Android candidate.

Lane: Verification/deploy
Outcome: verify, commit, build continuity-signed OTA, publish through the guarded
repo path, and record installed/smoked state honestly.
Files: release evidence only.
Boundary: publication is not physical-phone visual smoke.
Acceptance: public manifest identifies the exact commit and artifact digest.
Verification: `bash scripts/deploy.sh android` plus public gateway smoke.
Deploy target: Android OTA.

## Next product milestone

Add the secondary Activity/Switchboard using Working, Needs you, Held, and Done.
Wire an explicit Hold gesture to a durable voice draft plus transactional child
intent. A child setting/tool request completes with a scoped receipt, focus pops
back to the held thought, and newly admitted turns inherit the new profile.
