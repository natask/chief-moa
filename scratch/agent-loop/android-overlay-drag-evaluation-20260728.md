# Android overlay drag evaluation — 2026-07-28

Scope: read-only evaluation of `origin/master` at `fd8253680966a72e7fea313d3f5030b1197e1b0a`.
No runtime behavior was changed.

## Finding

The reported drag lag is plausible from the current implementation, but the
exact bottleneck is not proven without a device trace. Input is already
coalesced to one callback per display frame. The remaining code-confirmed cost
is that one callback moves several independent application-overlay windows via
`WindowManager.updateViewLayout()`.

The best first implementation is a bounded drag mode that moves only the
companion window while the pointer is down, temporarily soft-hides/freeze the
two ribbons and draft controls, and restores/reanchors them once on drop. This
reduces the ordinary transcript drag from three window-layout submissions per
frame to one without creating a large touch-blocking overlay or depending on
unsupported compositor APIs. Measure that candidate on the phone before a
larger one-window rewrite.

## Current touch-to-render path

1. `MoaOrbTouchListener.moveOrbTo()` writes `orbParams.x/y` for companion drags.
   `MoaRibbonTouchListener` and `MoaOverlayGroupDragListener` similarly update
   the companion anchor for ribbon/card drags.
2. `OverlayService.updateOrbDragSurfaces()` requests
   `MoaFrameCoalescer`, constructed with `MoaViewFrameScheduler(orbView)` in
   `OverlayService.showOrb()`.
3. `MoaFrameCoalescer.request()` retains only one pending callback and
   `MoaViewFrameScheduler` uses `View.postOnAnimation()`. Multiple motion events
   before the next frame therefore do not submit multiple layout passes.
4. `OverlayService.applyLatestOrbDragFrame()` then, in order:
   - repositions the composer if attached;
   - computes draft-control positions;
   - submits the companion window;
   - calls `MoaOverlayUnitController.position()` for both ribbons;
   - submits both draft-control windows if attached;
   - updates only the remove target's visual state when its active value changes.
5. Every submitted window ends in
   `MoaOverlayWindowLayout.update()` -> `WindowManager.updateViewLayout()`.

## Confirmed per-frame costs

The following counts are upper bounds from direct call paths, not measured
Binder transaction counts:

| Visible surfaces | Layout submissions in a drag frame |
| --- | ---: |
| Companion only | 1 |
| Companion + two ribbons | 3 |
| Companion + two ribbons + two draft controls | 5 |
| Composer + companion | 2 normally, up to 3 when composer placement also changes the orb Y |

`MoaOverlayUnitController` explicitly models the companion and ribbons as three
separate windows. Its `position()` has layout-state guards for ribbons, but both
ribbon coordinates change during a drag, so both guards pass on each drag
frame. The companion and draft-control calls have no equivalent changed-state
guard. `MoaOverlayWindowLayout.positionAnchored()` also submits the composer
unconditionally.

The drag-start path additionally calls `overlayUnit.setDragging(true)`, which
runs `applyPresence()`: palette/presence writes, animation cancellation,
companion alpha/scale writes, ribbon positioning, and touchability evaluation.
This is a start-of-gesture cost, not a repeated per-motion cost.

The remove target is a separate static window. It is added once at drag start;
normal frames only run bounds arithmetic, and repaint it when the armed state
changes. It is not repositioned every frame.

## What remains unproven

A real phone trace is required to distinguish among:

- main-thread time in view measure/layout/draw;
- `WindowManager.updateViewLayout()`/Binder and WindowManagerService latency;
- RenderThread/GPU composition of translucent ribbon/orb surfaces;
- concurrent voice callbacks, audio playback, or device thermal load;
- OEM overlay behavior and refresh-rate scheduling;
- whether the lag reproduces with the companion alone or only while ribbons,
  controls, or the composer are attached.

Capture a Perfetto/System Trace during four ten-second drags: companion alone,
two ribbons visible, active draft controls, and composer visible. Record frame
timeline/jank, main-thread slices, RenderThread, Binder calls, and SurfaceFlinger.
Also add a debug-only counter/timing seam around `applyLatestOrbDragFrame()` and
`MoaOverlayWindowLayout.update()` so the trace can correlate frames with the
number of submitted windows. Do not collect transcript text or microphone
content in performance evidence.

## Options

### 1. Keep multiple windows and make the drag path cheaper — recommended first

On drag start, close menus, freeze/soft-hide ribbons and draft controls, and
retain their content/state. During motion, update only the companion window and
the remove-target armed paint. On release/cancel, flush the final companion
position, recompute every dependent position once, restore visibility, and
preserve reversible removal behavior.

Benefits: one moving window; narrow change; preserves existing overlay touch
regions, IME behavior, z-order, API 26 support, ribbon lifetime, and the rule
that the full app owns deep history. It also gives a clean A/B measurement.

Trade-off: ribbons/controls will not visibly track the finger. Use a short fade
or compact-to-companion transition at the drag threshold so this reads as a
deliberate drag state, then restore after drop. A ribbon-originated gesture must
keep its source window attached until `ACTION_UP`; hiding is safe, detaching the
touched window mid-gesture is not.

Lower-risk improvements within this stage:

- add layout-state guards for the companion, composer, and draft controls;
- cache display metrics, dimensions, and insets for the duration of a drag;
- avoid `applyPresence()`/palette work except at drag start and end;
- ensure stream-driven geometry/presence updates do not submit extra overlay
  layouts while dragging; render text may continue into retained buffers.

These guards help non-drag churn, but because the companion position genuinely
changes every frame they cannot alone solve drag lag.

### 2. One compact root overlay for companion + ribbons — promising second stage

A compact `ViewGroup` could own companion and ribbons as children and move via
one `WindowManager.updateViewLayout()` per frame. Child placement and paint
would remain process-local. This is preferable to a full-screen overlay, and it
is the strongest long-term option if profiling proves window transaction count
is the bottleneck.

It is not a mechanical refactor. Android assigns input and obscuring behavior
at the window boundary. A rectangular root sized to the widest ribbon can
intercept touches in transparent gaps around the companion and can cover more
of the underlying app than the current three bounded windows. Dormant ribbons
currently become `FLAG_NOT_TOUCHABLE` independently; a combined window cannot
express that per child through ordinary public `WindowManager.LayoutParams`.
The implementation must therefore prove a compact dynamic bound, child hit
testing/pass-through behavior, accessibility focus, IME interaction, cutout and
navigation-inset placement, screen-edge flipping, and no regression to overlay
occlusion. Panel, menu, remove target, and undo chip should remain separate
surfaces.

### 3. Full-screen root plus child `translationX/Y` — reject

This would make visual movement cheap, but an application overlay's input region
is normally its window region, not the painted pixels. A full-screen touchable
overlay risks blocking the app underneath; making it `FLAG_NOT_TOUCHABLE`
also makes the companion unusable. It conflicts with the product requirement
that the small overlay minimally interrupts other apps.

### 4. Translate children within the current small windows — reject

`View.translationX/Y` is cheap only inside an existing window surface. Moving a
child beyond the surface bounds clips it, and the system's input window remains
at the old coordinates. Enlarging every surface enough to cover the screen
recreates the input/occlusion problem above.

### 5. `SurfaceControl` transaction — reject for this app

Directly moving surfaces is a platform/system-compositor technique, not a
stable public application-overlay contract across this app's API 26+ range.
Even if visual motion were accessible on a newer release, input coordinates and
WindowManager state would need synchronized updates. Avoid hidden APIs,
privileged permissions, reflection, and OEM-dependent behavior.

## Staged implementation recommendation

1. Add debug instrumentation and establish the four-scenario phone baseline.
2. Implement companion-only drag mode with frozen/soft-hidden dependents and
   changed-state guards. Keep the remove target and reversible removal semantics.
3. Re-run the same trace. Ship this stage if it meets the acceptance thresholds.
4. Only if it does not, prototype a compact combined companion+ribbon root behind
   an internal switch. Prove touch pass-through and accessibility before making
   it the default.

## Observable acceptance checks

- On the target phone, each of the four ten-second scenarios has at least 95%
  non-janky frames and no frame over 50 ms. Record device model, Android build,
  refresh rate, thermal state, and exact APK digest.
- Instrumentation shows no more than one moving-window layout submission per
  display frame during stage-1 motion; dependent windows receive one final
  reanchor on release/cancel.
- The companion remains within safe screen/cutout/navigation bounds after drag,
  rotation, and display resize.
- Dragging from companion and either ribbon crosses touch slop before movement;
  tap, hold, double-tap/history, voice press, and draft send/cancel retain their
  prior behavior.
- The remove target appears only after deliberate movement, arms only over its
  painted/tolerance bounds, removes only on a committed drop, and Undo restores
  the drag-start coordinates.
- Underlying apps remain touchable outside the painted companion/ribbon/control
  bounds before, during, and after drag.
- Active voice capture, streamed transcript updates, and audio playback continue
  without losing content while dependent surfaces are frozen, and restore the
  latest accumulated text after release.
- TalkBack can focus/activate the companion and visible ribbon actions; no large
  transparent overlay region is announced or intercepts exploration.
- Android unit tests and `ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew
  assembleDebug` pass; final acceptance includes real-phone QA because host-side
  tests cannot prove compositor smoothness.

## Source anchors

- `android_app/app/src/main/java/ai/moa/assistant/OverlayService.java`:
  `showOrb`, `showOrbRemoveTarget`, `updateOrbDragSurfaces`,
  `applyLatestOrbDragFrame`, `finishOrbDrag`, `dragUnitBy`,
  `prepareVoiceDraftControlPositions`, `updatePreparedVoiceDraftControlLayouts`.
- `android_app/app/src/main/java/ai/moa/assistant/MoaOrbTouchListener.java`:
  `moveOrbTo`.
- `android_app/app/src/main/java/ai/moa/assistant/MoaRibbonTouchListener.java` and
  `MoaOverlayGroupDragListener.java`: touch-slop and ribbon/card drag paths.
- `android_app/app/src/main/java/ai/moa/assistant/MoaFrameCoalescer.java` and
  `MoaViewFrameScheduler.java`: once-per-display-frame latest-state scheduling.
- `android_app/app/src/main/java/ai/moa/assistant/MoaOverlayUnitController.java`:
  `position`, `setDragging`, `applyPresence`, and ribbon gesture callbacks.
- `android_app/app/src/main/java/ai/moa/assistant/MoaOverlayWindowLayout.java`:
  `positionAnchored` and `update`.
