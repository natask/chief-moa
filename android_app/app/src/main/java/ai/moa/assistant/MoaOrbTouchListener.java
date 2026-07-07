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
// Flag ON (voice-first, v2):
//   single quick tap       -> talk toggle with barge-in. Loop off: onStartTalkLoop
//                             fires immediately on the first tap-up (it stops any
//                             assistant audio and opens the hands-free loop). Loop
//                             on: the tap defers onCommitAndEndLoop by the double-
//                             tap window so a second tap can supersede it.
//   double quick tap       -> onOpenChat. If tap 1 started the loop it is undone
//                             first via onCancelTalkLoop; if tap 1 deferred a send,
//                             that timer was cleared at tap 2's ACTION_DOWN so the
//                             loop simply stays on while chat opens.
//   triple tap and beyond  -> nothing (swallowed; the chord stays alive so rapid
//                             extra taps never re-toggle the loop)
//   press-and-hold, still  -> onDoublePressStart / onPressToTalkRelease
//                             (push to talk; the mic warms at press-down)
//   hold + large move      -> onPressToTalkCancel, then reposition the orb: once
//                             the hold has confirmed, a move past doubleTapSlop
//                             cancels the capture (nothing sent) and turns the
//                             gesture into a normal drag. Smaller drift is ignored.
//   press + move past slop -> reposition the orb, no callback (unchanged)
final class MoaOrbTouchListener implements View.OnTouchListener {
    private static final long DOUBLE_CLICK_HOLD_MS = 120;
    // Voice-first press-and-hold threshold. Deliberately separate from the
    // 120ms double-press hold: a first-press hold is the primary voice gesture,
    // so it wants a slightly longer window before it commits to talk vs a drag.
    private static final long VOICE_FIRST_HOLD_MS = 260;
    private static final long SINGLE_TAP_MAX_MS = ViewConfiguration.getLongPressTimeout();
    private static final long DOUBLE_TAP_TIMEOUT_MS = ViewConfiguration.getDoubleTapTimeout();

    // What the first tap of a voice-first chord did, so a second tap can undo or
    // supersede it. Mirrors the browser overlay's chain.toggled bookkeeping.
    private static final int TAP1_NONE = 0;
    private static final int TAP1_STARTED = 1;       // tap 1 started the loop
    private static final int TAP1_SEND_PENDING = 2;  // tap 1 deferred a commit+end

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
    // Voice-first callbacks (flag on). voiceLoopActive reports whether the
    // hands-free voice loop is running, so the first tap knows whether to start it
    // or to defer a send. onStartTalkLoop starts the loop with barge-in;
    // onCommitAndEndLoop commits any in-flight speech and ends it; onCancelTalkLoop
    // quietly drops a just-started loop; onOpenChat opens the chat panel;
    // onPressToTalkCancel aborts a confirmed hold's capture without committing.
    // The hold path reuses onDoublePressStart / onPressToTalkRelease and the
    // warm-mic pair onDoublePressArmed / onDoublePressAbort.
    private final BooleanSupplier voiceFirstEnabled;
    private final BooleanSupplier voiceLoopActive;
    private final Runnable onStartTalkLoop;
    private final Runnable onCommitAndEndLoop;
    private final Runnable onCancelTalkLoop;
    private final Runnable onOpenChat;
    private final Runnable onPressToTalkCancel;
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
    private int voiceFirstTap1Action;
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
            BooleanSupplier voiceLoopActive,
            Runnable onStartTalkLoop,
            Runnable onCommitAndEndLoop,
            Runnable onCancelTalkLoop,
            Runnable onOpenChat,
            Runnable onPressToTalkCancel
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
        this.voiceLoopActive = voiceLoopActive;
        this.onStartTalkLoop = onStartTalkLoop;
        this.onCommitAndEndLoop = onCommitAndEndLoop;
        this.onCancelTalkLoop = onCancelTalkLoop;
        this.onOpenChat = onOpenChat;
        this.onPressToTalkCancel = onPressToTalkCancel;
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

    // The voice-first contract (flag on, v2). Single quick tap toggles the talk
    // loop with barge-in, double tap opens chat, press-and-hold talks, and a large
    // move after the hold confirms cancels the capture into a drag. The plain drag
    // and coordinate clamp are unchanged.
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
                // A chord is already in progress, so this press-down is a potential
                // second (or later) tap. Suspend the pending tap-resolve now: for a
                // loop-active tap 1 that resolve carries the deferred commit+end, so
                // clearing it here lets tap 2 supersede the send and keeps the loop
                // on while chat opens. The chord count is preserved for the tap-up.
                if (voiceFirstTapCount > 0) {
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
                    // A confirmed press-to-talk owns the gesture. Small drift is
                    // ignored so a shaky hold never repositions the orb. A large
                    // move (past doubleTapSlop) is the escape hatch: cancel the
                    // capture the hold started without committing it, then let the
                    // drag reposition the orb from the current finger position.
                    if (Math.abs(dx) > doubleTapSlop || Math.abs(dy) > doubleTapSlop) {
                        voiceFirstHoldActive = false;
                        moved = true;
                        onPressToTalkCancel.run();
                        orbParams.x = clampOrbX(startX + dx);
                        orbParams.y = clampOrbY(startY + dy);
                        windowManager.updateViewLayout(orbView, orbParams);
                    }
                    return true;
                }
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
                    // A cancel or a drag is never a tap. A drag already reset the
                    // chord; the escape-hatch drag reset it when the hold confirmed.
                    return true;
                }
                handleVoiceFirstTapUp(event);
                return true;
            default:
                return false;
        }
    }

    // A quick tap released. Tap 1 toggles the loop: start it now (with barge-in)
    // when it is off, or defer a commit+end past the double-tap window when it is
    // on so a second tap can supersede. Tap 2 opens chat (undoing a just-started
    // loop). Tap 3+ does nothing but keeps the chord alive so extra taps stay inert.
    private void handleVoiceFirstTapUp(MotionEvent event) {
        voiceFirstTapCount++;
        if (voiceFirstTapCount == 1) {
            boolean loopActive = voiceLoopActive != null && voiceLoopActive.getAsBoolean();
            if (loopActive) {
                // Loop on: this tap means "send and end", but wait out the double-
                // tap window so a second tap (chat) can supersede it. The user has
                // already stopped talking by then, so the delay is not felt.
                voiceFirstTap1Action = TAP1_SEND_PENDING;
            } else {
                // Loop off (or the assistant is only speaking): start it now.
                // Starting stops any assistant audio, so barge-in is built in. A
                // second tap within the window undoes this just-started loop.
                voiceFirstTap1Action = TAP1_STARTED;
                onStartTalkLoop.run();
            }
            scheduleVoiceFirstTapResolve();
            return;
        }
        if (voiceFirstTapCount == 2) {
            // Double tap is chat. Tap 1 either started the loop (undo the
            // milliseconds-old session) or deferred a send (its resolve was
            // already cleared at this press-down, so the loop simply stays on).
            int tap1 = voiceFirstTap1Action;
            voiceFirstTap1Action = TAP1_NONE;
            if (tap1 == TAP1_STARTED) {
                onCancelTalkLoop.run();
            }
            onOpenChat.run();
            // Keep the chord alive so a third tap stays inert instead of
            // re-toggling. The re-armed resolve now carries no deferred action.
            scheduleVoiceFirstTapResolve();
            return;
        }
        // Third tap and beyond: nothing new. Keep swallowing rapid taps.
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
            int tap1 = voiceFirstTap1Action;
            voiceFirstTapCount = 0;
            voiceFirstTap1Action = TAP1_NONE;
            if (count == 1 && tap1 == TAP1_SEND_PENDING) {
                // A lone tap while the loop was on and no second tap arrived:
                // commit the in-flight utterance and end the loop.
                onCommitAndEndLoop.run();
            }
            // count == 1 TAP1_STARTED: the loop already started on the tap-up.
            // count >= 2: chat already opened. Nothing more to do here.
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
        voiceFirstTap1Action = TAP1_NONE;
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
