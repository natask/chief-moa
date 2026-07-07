package ai.moa.assistant;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;

import java.util.function.BooleanSupplier;

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
// Flag ON (voice-first):
//   single tap (quick)     -> onInterruptTap, fired immediately on the first
//                             tap-up with no deferral (compatible with a
//                             following double/triple tap); never opens chat
//   press-and-hold, still  -> onDoublePressStart / onPressToTalkRelease
//                             (push to talk; the mic warms at press-down)
//   press + move past slop -> reposition the orb, no callback (unchanged)
//   double-tap (quick)     -> onToggleTalk, toggle the continuous voice loop
//   triple-tap             -> onTripleTap, open the chat panel
final class MoaOrbTouchListener implements View.OnTouchListener {
    private static final long DOUBLE_CLICK_HOLD_MS = 120;
    // Voice-first press-and-hold threshold. Deliberately separate from the
    // 120ms double-press hold: a first-press hold is the primary voice gesture,
    // so it wants a slightly longer window before it commits to talk vs a drag.
    private static final long VOICE_FIRST_HOLD_MS = 260;
    private static final long SINGLE_TAP_MAX_MS = ViewConfiguration.getLongPressTimeout();
    private static final long DOUBLE_TAP_TIMEOUT_MS = ViewConfiguration.getDoubleTapTimeout();

    private final Context context;
    private final WindowManager windowManager;
    private final OrbView orbView;
    private final WindowManager.LayoutParams orbParams;
    // The live orb window size in pixels. It changes with the user's scale
    // pref, so it is stored as already-resolved pixels, not a dp base.
    private final int orbWindowPx;
    private final int edgeMarginDp;
    private final Runnable onSingleTap;
    private final Runnable onDoublePressStart;
    private final Runnable onPressToTalkRelease;
    // Fired the instant a second-tap press lands (before the hold confirms) so the
    // mic can warm and buffer a pre-roll. Its mate fires if that press resolves to
    // a drag or an early release, so the warm mic is dropped and never leaks.
    private final Runnable onDoublePressArmed;
    private final Runnable onDoublePressAbort;
    // Voice-first callbacks (flag on). onInterruptTap fires on a quick single
    // tap; onToggleTalk on a quick double tap; onTripleTap on a triple tap.
    // The hold path reuses onDoublePressStart / onPressToTalkRelease and the
    // warm-mic pair onDoublePressArmed / onDoublePressAbort.
    private final BooleanSupplier voiceFirstEnabled;
    private final Runnable onInterruptTap;
    private final Runnable onToggleTalk;
    private final Runnable onTripleTap;
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
    private int voiceFirstTapCount;
    private boolean voiceFirstHoldActive;
    private Runnable pendingVoiceFirstHold;
    private Runnable pendingVoiceFirstTapResolve;

    MoaOrbTouchListener(
            Context context,
            WindowManager windowManager,
            OrbView orbView,
            WindowManager.LayoutParams orbParams,
            int orbWindowPx,
            int edgeMarginDp,
            Runnable onSingleTap,
            Runnable onDoublePressStart,
            Runnable onPressToTalkRelease,
            Runnable onDoublePressArmed,
            Runnable onDoublePressAbort,
            BooleanSupplier voiceFirstEnabled,
            Runnable onInterruptTap,
            Runnable onToggleTalk,
            Runnable onTripleTap
    ) {
        this.context = context;
        this.windowManager = windowManager;
        this.orbView = orbView;
        this.orbParams = orbParams;
        this.orbWindowPx = orbWindowPx;
        this.edgeMarginDp = edgeMarginDp;
        this.onSingleTap = onSingleTap;
        this.onDoublePressStart = onDoublePressStart;
        this.onPressToTalkRelease = onPressToTalkRelease;
        this.onDoublePressArmed = onDoublePressArmed;
        this.onDoublePressAbort = onDoublePressAbort;
        this.voiceFirstEnabled = voiceFirstEnabled;
        this.onInterruptTap = onInterruptTap;
        this.onToggleTalk = onToggleTalk;
        this.onTripleTap = onTripleTap;
        ViewConfiguration viewConfiguration = ViewConfiguration.get(context);
        this.touchSlop = viewConfiguration.getScaledTouchSlop();
        this.doubleTapSlop = viewConfiguration.getScaledDoubleTapSlop();
    }

    @Override
    public boolean onTouch(View view, MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            gestureUsesVoiceFirst = voiceFirstEnabled != null && voiceFirstEnabled.getAsBoolean();
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
                orbParams.x = clampOrbX(startX + dx);
                orbParams.y = clampOrbY(startY + dy);
                windowManager.updateViewLayout(orbView, orbParams);
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                cancelPendingDoublePress();
                if (doublePressActive) {
                    doublePressActive = false;
                    lastTapCandidate = false;
                    onPressToTalkRelease.run();
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
                    lastTapCandidate = false;
                    return true;
                }
                scheduleSingleTap(event);
                return true;
            default:
                return false;
        }
    }

    // The voice-first contract (flag on). Single tap interrupts, press-and-hold
    // talks, double tap toggles the loop, triple tap opens chat. Drag and the
    // coordinate clamp are unchanged.
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
                // Warm the mic on this press-down so a hold-to-talk buffers the
                // head of the utterance from the very first press. A quick
                // release or a drag drops it; only a confirmed hold consumes it.
                onDoublePressArmed.run();
                scheduleVoiceFirstHold();
                return true;
            case MotionEvent.ACTION_MOVE:
                if (voiceFirstHoldActive) {
                    // A confirmed press-to-talk owns the gesture: ignore drift so
                    // a shaky hold never repositions the orb.
                    return true;
                }
                int dx = Math.round(event.getRawX() - downX);
                int dy = Math.round(event.getRawY() - downY);
                if (!moved && (Math.abs(dx) > touchSlop || Math.abs(dy) > touchSlop)) {
                    moved = true;
                    // Drift past the slop before the hold confirms is a drag:
                    // cancel the hold, drop the warm mic, and end any in-progress
                    // tap chord so a reposition never fires talk or chat.
                    cancelVoiceFirstHold();
                    onDoublePressAbort.run();
                    resetVoiceFirstTapChord();
                }
                orbParams.x = clampOrbX(startX + dx);
                orbParams.y = clampOrbY(startY + dy);
                windowManager.updateViewLayout(orbView, orbParams);
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                cancelVoiceFirstHold();
                if (voiceFirstHoldActive) {
                    // Release of a confirmed press-to-talk: commit the turn.
                    voiceFirstHoldActive = false;
                    resetVoiceFirstTapChord();
                    onPressToTalkRelease.run();
                    return true;
                }
                // No hold consumed the warm mic, so drop it.
                onDoublePressAbort.run();
                if (action == MotionEvent.ACTION_CANCEL || moved) {
                    // A cancel or a drag is never a tap.
                    return true;
                }
                handleVoiceFirstTapUp(event);
                return true;
            default:
                return false;
        }
    }

    // A quick tap released. Interrupt fires on the first tap-up immediately, then
    // the count decides: two -> toggle talk (after the double-tap window, so a
    // third tap can supersede it), three -> chat now.
    private void handleVoiceFirstTapUp(MotionEvent event) {
        voiceFirstTapCount++;
        if (voiceFirstTapCount == 1) {
            onInterruptTap.run();
            scheduleVoiceFirstTapResolve();
            return;
        }
        if (voiceFirstTapCount == 2) {
            // Could still grow into a triple tap; wait one more window.
            scheduleVoiceFirstTapResolve();
            return;
        }
        // Third tap: open chat now and end the chord without waiting.
        cancelVoiceFirstTapResolve();
        voiceFirstTapCount = 0;
        onTripleTap.run();
    }

    private void scheduleVoiceFirstHold() {
        cancelVoiceFirstHold();
        pendingVoiceFirstHold = () -> {
            pendingVoiceFirstHold = null;
            if (moved) {
                return;
            }
            voiceFirstHoldActive = true;
            // A confirmed hold is push-to-talk. Abandon any pending tap chord and
            // hand the still-warm mic to the start handler (record mode routes
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
            int count = voiceFirstTapCount;
            voiceFirstTapCount = 0;
            if (count == 2) {
                onToggleTalk.run();
            }
            // count == 1: interrupt already fired on the tap-up; nothing more.
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
        voiceFirstTapCount = 0;
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

    private void scheduleSingleTap(MotionEvent event) {
        cancelPendingSingleTap();
        lastTapCandidate = true;
        lastTapUpTimeMs = event.getEventTime();
        lastTapUpX = event.getRawX();
        lastTapUpY = event.getRawY();
        pendingSingleTap = () -> {
            pendingSingleTap = null;
            if (lastTapCandidate) {
                lastTapCandidate = false;
                onSingleTap.run();
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
        int max = context.getResources().getDisplayMetrics().widthPixels - orbWindowPx - margin;
        return Math.max(margin, Math.min(value, max));
    }

    private int clampOrbY(int value) {
        int margin = dp(edgeMarginDp);
        int max = context.getResources().getDisplayMetrics().heightPixels - orbWindowPx - margin;
        return Math.max(margin, Math.min(value, max));
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
