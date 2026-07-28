# Android single-root drag ticket

## Observed problem

The physical phone still lagged after the first drag optimization. That version
moved only the companion window and hid the other compact surfaces, but every
rendered drag frame still crossed Android's WindowManager boundary.

## Implementation unit

Own the companion, current user/assistant ribbons, and voice-draft controls in
one bounded compact overlay root. Keep the focused composer, removal target,
Undo chip, menus, and full history separate. Coalesce pointer moves to display
frames and submit the compact root exactly once per moving frame.

## Acceptance evidence

- A root test records one WindowManager update for one committed drag frame.
- Geometry tests cover compact union, screen-to-local rebasing, and empty state.
- Existing gesture, remove-target, Undo, voice, copy/history, and presence tests
  remain green.
- Android JVM tests and `assembleDebug` pass.
- Physical-phone frame pacing and touch pass-through remain release QA evidence;
  this implementation task does not claim installation or smoke without it.
