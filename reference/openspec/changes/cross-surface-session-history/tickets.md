# Cross-Surface Session History Lane Tickets

Source evidence: [Android product-direction voice note](../../../scratch/agent-loop/android-product-direction-voice-note-20260716.md)
and the change-local [source evidence map](source-evidence.md).

## Browser voice

Lane: Browser voice

Outcome: Make the existing side panel hydrate and retain the canonical shared-session user/assistant history across panel reopen and extension-worker restart while the on-page overlay remains transient.

Files: `browser_extension/extension/sidepanel.js`, `browser_extension/extension/sidepanel.html`, the background history bridge, and isolated side-panel history smoke coverage.

Boundary: Microphone capture stays extension-owned; conversation state stays gateway-owned; no provider credentials or page content become local history authority.

Acceptance: An isolated Chrome profile shows seeded mixed-source user/assistant turns on first panel open and shows the same deduplicated turns after panel reopen or service-worker restart.

Verification: `cd browser_extension && npm run verify && npm run smoke:sidepanel && npm run smoke`.

Deploy target or blocker: Create a collision-free extension package; do not reload the user's active browser unless the no-interruption gate passes.

## Browser action/CDP

Lane: Browser action/CDP

Outcome: Out of scope for this implementation wave; history records may display existing terminal browser-task receipts, but no new CDP/action authority is introduced.

Files: None beyond additive projection fields if already present in canonical message records.

Boundary: The gateway proposes; the extension validates, executes, and receipts browser-local actions.

Acceptance: The history change neither adds a CDP method nor changes browser-action approval behavior.

Verification: Existing extension automation smokes remain green.

Deploy target or blocker: Same extension artifact; no separate deploy.

## Android action/accessibility

Lane: Android action/accessibility

Outcome: Add mixed shared-session history to the full Android app while keeping the overlay compact and non-canonical.

Files: `MoaGatewayClient.java`, `MainActivity.java`, a bounded history projection/model if needed, and unit tests.

Boundary: Android continues to own phone UI, permissions, approvals, execution, and receipts; history is read-only evidence.

Acceptance: After a seeded Android voice turn and typed turn, the full app shows their user text, assistant text, branch, source/classification, and shared session after a process-level refresh.

Verification: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest assembleDebug`.

Deploy target or blocker: Build an OTA artifact only; do not install or restart the user's active phone session without a safe window.

## Gateway

Lane: Gateway

Outcome: Expose one authenticated, bounded session-message projection over voice, chat, browser, and broker records with complete text and stable identities.

Files: session-read handlers, the existing history/session projection or a narrow extracted module, and focused tests/smokes.

Boundary: History is evidence, not execution authority; incognito stays absent; assistant output never becomes user-authored intent.

Acceptance: A seeded shared session returns one ordered, deduplicated projection containing Android voice, Android chat, browser turn, and broker evidence with stable IDs and untruncated long user text within the documented bound.

Verification: Focused handler/projection tests followed by `cd gateway && npm run check`.

Deploy target or blocker: Isolated preview/state first. Production promotion is blocked while `drain_safe=false` or backup/restore/no-interruption evidence is incomplete.

## Workflow/docs

Lane: Workflow/docs

Outcome: Preserve the recovered Android note and record this first recovery wave plus staged follow-on outcomes.

Files: this OpenSpec change and the linked source note.

Boundary: The recovered message is user intent evidence; this current request authorizes this bounded implementation wave, not posting to external services or unrestricted recurring mutation.

Acceptance: The source note, product contract, ordered implementation tasks, and explicit follow-ons are validated and resume-safe.

Verification: `openspec validate cross-surface-session-history --strict`.

Deploy target or blocker: Documentation is non-deployable.

## Verification/deploy

Lane: Verification/deploy

Outcome: Independently prove the exact integrated candidate without opening foreground UI, reloading the daily browser, installing on the active phone, or restarting the live gateway.

Files: Isolated gateway/browser/Android tests and candidate-bound evidence only.

Boundary: Verification does not repair its own candidate; promotion remains gated by rollback, compatibility, no interruption, and backup/restore evidence.

Acceptance: One seeded long Android message is returned by the gateway projection and rendered by both the browser side panel and Android full app in isolated tests after reopen/restart.

Verification: Gateway check and focused smoke, extension verify/smoke in a throwaway profile, Android unit/build checks, and OpenSpec validation.

Deploy target or blocker: Package browser and Android artifacts and create a gateway preview where possible; otherwise record exact blockers. Promote only through the repository release path when the active-promotion gate passes.

## Staged follow-on outcomes

- Canonical project mapping, unified worker queues, broker-first capture/linkage, live worker readiness, and then opt-in recurring agent schedules.
- Native Android overlay layout/removal ergonomics and five-design exploration.
- Continuous STT/audio evidence evaluation and provider comparison.
- Multimodal annotated video/presentation input.
- Canonical shared-session macOS chat/history first; Windows and iPhone after native transport, packaging, signing, installation, and recovery evidence.
