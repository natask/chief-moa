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
