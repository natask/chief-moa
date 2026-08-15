package ag.companion;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;

import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Supplier;

// Orb gestures. The overlay runs one of two contracts depending on the
// experimental voice-first flag (MoaPrefs.voiceFirstGestures), latched per
// gesture at ACTION_DOWN so flipping the flag never splits one touch.
//
// Flag OFF (default, unchanged):
//   single tap             -> onSingleTap, chat menu
//   first press and drag   -> reposition the orb, no callback
//   double-click and hold  -> onDoublePressStart / onPressToTalkRelease
//   A single tap is confirmed only after the double-tap window passes, so the
//   chat menu never flashes before a double-click hold engages voice.
//
// Flag ON (manual voice):
//   single quick tap       -> toggle current-thread capture; inert during fresh-thread capture
//   double quick tap       -> toggle fresh-thread capture, replacing an active current draft
//   triple quick tap       -> cancel an active draft and open chat
//   fourth tap and beyond  -> nothing
//   press-and-hold, still  -> onDoublePressStart / onPressToTalkRelease
//                             (push to talk; the mic warms at press-down)
//   hold + large move      -> reposition the unit while capture stays active;
//                             release still commits the owned push-to-talk turn.
//   press + move past slop -> reposition the orb, no callback (unchanged)
final class MoaOrbTouchListener implements View.OnTouchListener {
    private static final long DOUBLE_CLICK_HOLD_MS = 120;
    // Voice-first press-and-hold threshold. Deliberately separate from the
    // 120ms double-press hold: a first-press hold is the primary voice gesture,
    // so it wants a slightly longer window before it commits to talk vs a drag.
    private static final long VOICE_FIRST_HOLD_MS = 260;
    private static final long SINGLE_TAP_MAX_MS = ViewConfiguration.getLongPressTimeout();
    private static final long DOUBLE_TAP_TIMEOUT_MS = ViewConfiguration.getDoubleTapTimeout();

    private final Context context;
    private final WindowManager.LayoutParams orbParams;
    // The live orb window size in pixels. It changes with the user's scale
    // pref, so it is stored as already-resolved pixels, not a dp base.
    private final int fallbackOrbWindowPx;
    private final int edgeMarginDp;
    private final Runnable onSingleTap;
    private final Runnable onDoublePressStart;
    private final Runnable onPressToTalkRelease;
    // Fired the instant a second-tap press lands (before the hold confirms) so the
    // mic can warm and buffer a pre-roll. Its mate fires if that press resolves to
    // a drag or an early release, so the warm mic is dropped and never leaks.
    private final Runnable onDoublePressArmed;
    private final Runnable onDoublePressAbort;
    // Manual-voice callbacks (flag on). manualCaptureOrigin distinguishes an
    // open current-thread capture from one opened by the double-tap fresh-thread
    // toggle. Assistant speech is not capture: a tap during speech interrupts it.
    // onPressToTalkCancel aborts a confirmed hold's capture without committing.
    // The hold path reuses onDoublePressStart / onPressToTalkRelease and the
    // warm-mic pair onDoublePressArmed / onDoublePressAbort.
    private final BooleanSupplier voiceFirstEnabled;
    private final Supplier<MoaVoiceFirstTapResolver.CaptureOrigin> manualCaptureOrigin;
    private final Runnable onStartTalkLoop;
    private final Runnable onSendTalkLoop;
    private final Runnable onStartFreshTalkLoop;
    private final Runnable onCancelTalkLoop;
    private final Runnable onOpenChat;
    private final Runnable onPressToTalkCancel;
    private final Runnable onOrbDragStart;
    private final Runnable onOrbDragMove;
    private final Consumer<Boolean> onOrbDragEnd;
    private final MoaVoiceFirstTapResolver voiceFirstTapResolver = new MoaVoiceFirstTapResolver();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final int touchSlop;
    private final int doubleTapSlop;

    private int startX;
    private int startY;
    private float downX;
    private float downY;
    private long downTimeMs;
    private boolean moved;
    private boolean doublePressPending;
    private boolean doublePressActive;
    private boolean lastTapCandidate;
    private long lastTapUpTimeMs;
    private float lastTapUpX;
    private float lastTapUpY;
    private Runnable pendingSingleTap;
    private Runnable pendingDoublePressStart;

    // Voice-first machine state. Which contract a gesture uses is latched at
    // ACTION_DOWN so a mid-gesture flag flip cannot mix the two machines.
    private boolean gestureUsesVoiceFirst;
    private boolean voiceFirstHoldActive;
    private boolean voiceFirstHoldDragging;
    private Runnable pendingVoiceFirstHold;
    private Runnable pendingVoiceFirstTapResolve;

    void bindKeyboardAction(OrbView orb) {
        if (orb != null) {
            orb.setKeyboardPrimaryAction(this::performKeyboardPrimaryAction);
        }
    }

    /** Immediate equivalent of the primary tap for keyboard and switch users. */
    private void performKeyboardPrimaryAction() {
        boolean voiceFirst = voiceFirstEnabled != null && voiceFirstEnabled.getAsBoolean();
        if (!voiceFirst) {
            onSingleTap.run();
            return;
        }
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();
        resolver.tapUp();
        MoaVoiceFirstTapResolver.CaptureOrigin origin = manualCaptureOrigin == null
                ? MoaVoiceFirstTapResolver.CaptureOrigin.NONE
                : manualCaptureOrigin.get();
        runVoiceFirstTapActions(resolver.resolve(origin));
    }

    MoaOrbTouchListener(
            Context context,
            WindowManager.LayoutParams orbParams,
            int orbWindowPx,
            int edgeMarginDp,
            Runnable onSingleTap,
            Runnable onDoublePressStart,
            Runnable onPressToTalkRelease,
            Runnable onDoublePressArmed,
            Runnable onDoublePressAbort,
            BooleanSupplier voiceFirstEnabled,
            Supplier<MoaVoiceFirstTapResolver.CaptureOrigin> manualCaptureOrigin,
            Runnable onStartTalkLoop,
            Runnable onSendTalkLoop,
            Runnable onStartFreshTalkLoop,
            Runnable onCancelTalkLoop,
            Runnable onOpenChat,
            Runnable onPressToTalkCancel,
            Runnable onOrbDragStart,
            Runnable onOrbDragMove,
            Consumer<Boolean> onOrbDragEnd
    ) {
        this.context = context;
        this.orbParams = orbParams;
        this.fallbackOrbWindowPx = orbWindowPx;
        this.edgeMarginDp = edgeMarginDp;
        this.onSingleTap = onSingleTap;
        this.onDoublePressStart = onDoublePressStart;
        this.onPressToTalkRelease = onPressToTalkRelease;
        this.onDoublePressArmed = onDoublePressArmed;
        this.onDoublePressAbort = onDoublePressAbort;
        this.voiceFirstEnabled = voiceFirstEnabled;
        this.manualCaptureOrigin = manualCaptureOrigin;
        this.onStartTalkLoop = onStartTalkLoop;
        this.onSendTalkLoop = onSendTalkLoop;
        this.onStartFreshTalkLoop = onStartFreshTalkLoop;
        this.onCancelTalkLoop = onCancelTalkLoop;
        this.onOpenChat = onOpenChat;
        this.onPressToTalkCancel = onPressToTalkCancel;
        this.onOrbDragStart = onOrbDragStart;
        this.onOrbDragMove = onOrbDragMove;
        this.onOrbDragEnd = onOrbDragEnd;
        ViewConfiguration viewConfiguration = ViewConfiguration.get(context);
        this.touchSlop = viewConfiguration.getScaledTouchSlop();
        this.doubleTapSlop = viewConfiguration.getScaledDoubleTapSlop();
    }

    @Override
    public boolean onTouch(View view, MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            view.animate().cancel();
            view.setAlpha(1f);
            gestureUsesVoiceFirst = voiceFirstEnabled != null && voiceFirstEnabled.getAsBoolean();
        } else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            view.animate().alpha(MoaOrbPresentation.IDLE_ALPHA).setDuration(180).start();
        }
        if (gestureUsesVoiceFirst) {
            return onTouchVoiceFirst(view, event);
        }
        return onTouchLegacy(view, event);
    }

    // The original, flag-off contract. Byte-for-byte the same logic as before;
    // only moved into its own method behind the ACTION_DOWN flag latch.
    private boolean onTouchLegacy(View view, MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            startX = orbParams.x;
            startY = orbParams.y;
            downX = event.getRawX();
            downY = event.getRawY();
            downTimeMs = event.getEventTime();
            moved = false;

            if (isSecondTap(event)) {
                cancelPendingSingleTap();
                beginPendingDoublePress();
                // Warm the mic now, at the second-tap press, so the head of the
                // utterance is buffered while the ~120ms hold confirms. Single
                // taps and drags never reach this branch, so the mic indicator
                // only lights on a genuine double-press gesture.
                onDoublePressArmed.run();
            } else {
                cancelPendingSingleTap();
                lastTapCandidate = false;
                doublePressPending = false;
                doublePressActive = false;
            }
        }

        switch (action) {
            case MotionEvent.ACTION_DOWN:
                return true;
            case MotionEvent.ACTION_MOVE:
                if (doublePressActive) {
                    return true;
                }
                int dx = Math.round(event.getRawX() - downX);
                int dy = Math.round(event.getRawY() - downY);
                if (Math.abs(dx) > touchSlop || Math.abs(dy) > touchSlop) {
                    if (!moved) onOrbDragStart.run();
                    moved = true;
                    // Drift past the slop turns a not-yet-confirmed double press
                    // into a drag. Clear doublePressPending as well as the timer:
                    // otherwise ACTION_UP takes the `doublePressPending` branch and
                    // returns without firing any callback, silently swallowing the
                    // whole gesture. Cleared, the release falls through to the
                    // normal moved/single-tap logic below.
                    boolean wasArmed = doublePressPending;
                    doublePressPending = false;
                    cancelPendingDoublePress();
                    if (wasArmed) {
                        // The warmed mic will never be handed to a session; drop it.
                        onDoublePressAbort.run();
                    }
                }
                if (moved) {
                    moveOrbTo(event);
                    onOrbDragMove.run();
                }
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                cancelPendingDoublePress();
                if (doublePressActive) {
                    doublePressActive = false;
                    lastTapCandidate = false;
                    if (action == MotionEvent.ACTION_UP) {
                        onPressToTalkRelease.run();
                    } else {
                        onPressToTalkCancel.run();
                    }
                    return true;
                }
                if (doublePressPending) {
                    // Released before the hold confirmed: the mic warmed but no
                    // session will take it. Drop the warm mic and its pre-roll.
                    doublePressPending = false;
                    lastTapCandidate = false;
                    onDoublePressAbort.run();
                    return true;
                }
                if (moved || action == MotionEvent.ACTION_CANCEL || event.getEventTime() - downTimeMs > SINGLE_TAP_MAX_MS) {
                    if (moved) {
                        if (action == MotionEvent.ACTION_UP) {
                            moveOrbTo(event);
                            onOrbDragMove.run();
                        }
                        onOrbDragEnd.accept(action == MotionEvent.ACTION_UP);
                    }
                    lastTapCandidate = false;
                    return true;
                }
                scheduleSingleTap(view, event);
                return true;
            default:
                return false;
        }
    }

    // The manual-voice contract. Quick taps resolve as a single/double/triple
    // chord against current capture provenance; provider silence never commits.
    // Hold-release remains the immediate push-to-talk shortcut.
    private boolean onTouchVoiceFirst(View view, MotionEvent event) {
        int action = event.getActionMasked();
        switch (action) {
            case MotionEvent.ACTION_DOWN:
                startX = orbParams.x;
                startY = orbParams.y;
                downX = event.getRawX();
                downY = event.getRawY();
                downTimeMs = event.getEventTime();
                moved = false;
                voiceFirstHoldActive = false;
                voiceFirstHoldDragging = false;
                if (voiceFirstTapResolver.hasOpenChord()) {
                    cancelVoiceFirstTapResolve();
                }
                // Warm the mic on this press-down so a hold-to-talk buffers the
                // head of the utterance from the very first press. A quick
                // release or a drag drops it; only a confirmed hold consumes it.
                onDoublePressArmed.run();
                scheduleVoiceFirstHold();
                return true;
            case MotionEvent.ACTION_MOVE:
                int dx = Math.round(event.getRawX() - downX);
                int dy = Math.round(event.getRawY() - downY);
                if (voiceFirstHoldActive) {
                    // Moving a live capture repositions the compact unit. It does
                    // not become a hidden cancel gesture: capture remains visibly
                    // owned until release, which commits it normally.
                    if (Math.abs(dx) > doubleTapSlop || Math.abs(dy) > doubleTapSlop) {
                        if (!voiceFirstHoldDragging) {
                            voiceFirstHoldDragging = true;
                            moved = true;
                            onOrbDragStart.run();
                        }
                        moveOrbTo(event);
                        onOrbDragMove.run();
                    }
                    return true;
                }
                if (!moved && (Math.abs(dx) > touchSlop || Math.abs(dy) > touchSlop)) {
                    moved = true;
                    onOrbDragStart.run();
                    // Drift past the slop before the hold confirms is a drag:
                    // cancel the hold, drop the warm mic, and end any in-progress
                    // tap chord so a reposition never fires talk or chat.
                    cancelVoiceFirstHold();
                    onDoublePressAbort.run();
                    resetVoiceFirstTapChord();
                }
                if (moved) {
                    moveOrbTo(event);
                    onOrbDragMove.run();
                }
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                cancelVoiceFirstHold();
                if (voiceFirstHoldActive) {
                    // A real release commits; Android gesture cancellation stays
                    // an explicit non-commit path.
                    voiceFirstHoldActive = false;
                    resetVoiceFirstTapChord();
                    if (action == MotionEvent.ACTION_UP) {
                        if (voiceFirstHoldDragging) {
                            moveOrbTo(event);
                            onOrbDragMove.run();
                            onOrbDragEnd.accept(true);
                        }
                        onPressToTalkRelease.run();
                    } else {
                        if (voiceFirstHoldDragging) {
                            onOrbDragEnd.accept(false);
                        }
                        onPressToTalkCancel.run();
                    }
                    voiceFirstHoldDragging = false;
                    return true;
                }
                // No hold consumed the warm mic, so drop it.
                onDoublePressAbort.run();
                if (action == MotionEvent.ACTION_CANCEL || moved) {
                    if (moved) {
                        if (action == MotionEvent.ACTION_UP) {
                            moveOrbTo(event);
                            onOrbDragMove.run();
                        }
                        onOrbDragEnd.accept(action == MotionEvent.ACTION_UP);
                    }
                    // A cancel or drag is never a tap and cannot leave a partially
                    // entered click chord armed.
                    resetVoiceFirstTapChord();
                    return true;
                }
                handleVoiceFirstTapUp(event);
                return true;
            default:
                return false;
        }
    }

    // Resolve only after the multi-click window. That short deferral is required
    // so tap 1 of a double/triple chord cannot send an active draft before the
    // final gesture meaning is known.
    private void handleVoiceFirstTapUp(MotionEvent event) {
        voiceFirstTapResolver.tapUp();
        scheduleVoiceFirstTapResolve();
    }

    private void scheduleVoiceFirstHold() {
        cancelVoiceFirstHold();
        pendingVoiceFirstHold = () -> {
            pendingVoiceFirstHold = null;
            if (moved) {
                return;
            }
            voiceFirstHoldActive = true;
            // A confirmed hold is push-to-talk. Abandon a pending tap chord and
            // hand the still-warm mic to the
            // start handler (record mode routes
            // the same callback to a note capture).
            resetVoiceFirstTapChord();
            onDoublePressStart.run();
        };
        mainHandler.postDelayed(pendingVoiceFirstHold, VOICE_FIRST_HOLD_MS);
    }

    private void cancelVoiceFirstHold() {
        if (pendingVoiceFirstHold != null) {
            mainHandler.removeCallbacks(pendingVoiceFirstHold);
            pendingVoiceFirstHold = null;
        }
    }

    private void scheduleVoiceFirstTapResolve() {
        cancelVoiceFirstTapResolve();
        pendingVoiceFirstTapResolve = () -> {
            pendingVoiceFirstTapResolve = null;
            MoaVoiceFirstTapResolver.CaptureOrigin origin = manualCaptureOrigin == null
                    ? MoaVoiceFirstTapResolver.CaptureOrigin.NONE
                    : manualCaptureOrigin.get();
            runVoiceFirstTapActions(voiceFirstTapResolver.resolve(origin));
        };
        mainHandler.postDelayed(pendingVoiceFirstTapResolve, DOUBLE_TAP_TIMEOUT_MS);
    }

    private void cancelVoiceFirstTapResolve() {
        if (pendingVoiceFirstTapResolve != null) {
            mainHandler.removeCallbacks(pendingVoiceFirstTapResolve);
            pendingVoiceFirstTapResolve = null;
        }
    }

    private void resetVoiceFirstTapChord() {
        cancelVoiceFirstTapResolve();
        voiceFirstTapResolver.reset();
    }

    private void runVoiceFirstTapActions(List<MoaVoiceFirstTapResolver.Action> actions) {
        MoaOrbTouchActionDispatcher.dispatch(
                actions,
                onStartTalkLoop,
                onSendTalkLoop,
                onCancelTalkLoop,
                onStartFreshTalkLoop,
                onOpenChat
        );
    }

    private boolean isSecondTap(MotionEvent event) {
        if (!lastTapCandidate || pendingSingleTap == null) {
            return false;
        }
        long elapsedMs = event.getEventTime() - lastTapUpTimeMs;
        if (elapsedMs < 0 || elapsedMs > DOUBLE_TAP_TIMEOUT_MS) {
            return false;
        }
        float dx = event.getRawX() - lastTapUpX;
        float dy = event.getRawY() - lastTapUpY;
        return dx * dx + dy * dy <= doubleTapSlop * doubleTapSlop;
    }

    private void scheduleSingleTap(View view, MotionEvent event) {
        cancelPendingSingleTap();
        lastTapCandidate = true;
        lastTapUpTimeMs = event.getEventTime();
        lastTapUpX = event.getRawX();
        lastTapUpY = event.getRawY();
        pendingSingleTap = () -> {
            pendingSingleTap = null;
            if (lastTapCandidate) {
                lastTapCandidate = false;
                if (!view.performClick()) {
                    onSingleTap.run();
                }
            }
        };
        mainHandler.postDelayed(pendingSingleTap, DOUBLE_TAP_TIMEOUT_MS);
    }

    private void cancelPendingSingleTap() {
        if (pendingSingleTap == null) {
            return;
        }
        mainHandler.removeCallbacks(pendingSingleTap);
        pendingSingleTap = null;
    }

    private void beginPendingDoublePress() {
        doublePressPending = true;
        lastTapCandidate = false;
        cancelPendingDoublePress();
        pendingDoublePressStart = () -> {
            pendingDoublePressStart = null;
            if (!doublePressPending || moved) {
                return;
            }
            doublePressPending = false;
            doublePressActive = true;
            onDoublePressStart.run();
        };
        mainHandler.postDelayed(pendingDoublePressStart, DOUBLE_CLICK_HOLD_MS);
    }

    private void cancelPendingDoublePress() {
        if (pendingDoublePressStart == null) {
            return;
        }
        mainHandler.removeCallbacks(pendingDoublePressStart);
        pendingDoublePressStart = null;
    }

    private int clampOrbX(int value) {
        int margin = dp(edgeMarginDp);
        int max = context.getResources().getDisplayMetrics().widthPixels - currentOrbWindowPx() - margin;
        return Math.max(margin, Math.min(value, max));
    }

    private void moveOrbTo(MotionEvent event) {
        int dx = Math.round(event.getRawX() - downX);
        int dy = Math.round(event.getRawY() - downY);
        orbParams.x = clampOrbX(startX + dx);
        orbParams.y = clampOrbY(startY + dy);
    }

    private int clampOrbY(int value) {
        int margin = dp(edgeMarginDp);
        int max = context.getResources().getDisplayMetrics().heightPixels - currentOrbWindowPx() - margin;
        return Math.max(margin, Math.min(value, max));
    }

    private int currentOrbWindowPx() {
        return orbParams.width > 0 ? orbParams.width : fallbackOrbWindowPx;
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
