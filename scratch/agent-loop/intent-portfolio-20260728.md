# Android intent portfolio implementation unit

## Captured outcome

Make ongoing product intentions visible in Chief Moa so the user does not need
to remember which requested projects exist or where each sits in implementation.

## Lane split

- Gateway: reuse the authenticated canonical intent list projection; do not add
  another store or execution authority.
- Android: add a bounded full-app portfolio; keep the overlay small.
- Browser: no code in this unit; it can consume the same projection later.
- Workflow/docs: reconcile the already-shipped runtime tasks and record this
  Android acceptance slice.
- Verification/deploy: Android unit tests and debug build, then continuity-signed
  OTA artifact only if the active-promotion safety gate can be proven.

## Observable acceptance check

Open the Android full app against a compatible gateway and tap Refresh. Recent
canonical intents appear with lifecycle, objective, next step, blocker count,
and linked run count. Against an older or unavailable gateway, the app reports
the portfolio as unavailable and does not invent local intent state.

## Follow-on dependencies

The editable source-segment split, parallel lane approval, named agent launch,
follow-up, cancellation, and cross-surface restoration remain the next
`canonical-intent-runtime` milestone after this inspection surface.

## Release evidence

- Verification: Android unit tests and `assembleDebug` passed; gateway
  `npm run check` passed; both relevant OpenSpec changes passed strict
  validation.
- Release artifact: `ai.moa.assistant-1785286596`, version
  `0.1.1785286596`, candidate commit `c8758e14`, SHA-256
  `3a54793e0837db26ac112742be26fc91910eb0e32615269d9d973eb7f7940f0c`.
- Signer continuity: APK certificate SHA-256 matches the documented development
  continuity signer,
  `8f0b62c73777a961687041f6faac24597830127d1f0ca9841aa6f7c70fe6ae0d`.
- Artifact path: `android_app/deploy/preview/intent-portfolio-c8758e14/`.
- Active promotion blocker: physical-phone UI QA and proof that an OTA install
  will not interrupt an active phone session are absent. This branch is also 22
  commits ahead of its remote base, so publishing it would promote more than
  this narrow unit. The stable OTA head was not moved.
