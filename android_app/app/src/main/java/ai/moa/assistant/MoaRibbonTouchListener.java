package ai.moa.assistant;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;

/**
 * Ribbon gestures, sharing slop, hold and multi-tap thresholds with the
 * companion so the three windows feel like one object.
 *
 * <pre>
 *   tap          solidify + latch engaged, reveal the copy rail
 *   tap on rail  copy the FULL buffer
 *   hold         open the ribbon menu
 *   double tap   open History, which is a separate surface
 *   drag         move the whole unit; the anchor is always the companion
 * </pre>
 *
 * A drag past slop cancels the pending tap and hold, matching the companion's
 * existing "large movement escapes into drag" rule.
 *
 * Touches that do not land on the painted glyph run are not taken at all
 * ({@link MoaRibbonView#hitsInteractive}), so an idle ribbon is inert.
 */
final class MoaRibbonTouchListener implements View.OnTouchListener {
    interface Callbacks {
        void onPressChanged(boolean down);

        void onTap();

        void onCopy();

        void onHistory();

        void onHold();

        void onDoubleTap();

        void onDragStart();

        void onDragMove(int dx, int dy);

        void onDragEnd(boolean committed);
    }

    private final MoaRibbonView ribbon;
    private final Callbacks callbacks;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final int touchSlop;

    private float downX;
    private float downY;
    private boolean dragging;
    private boolean holdFired;
    private boolean railPress;
    private boolean historyPress;
    private boolean owned;
    private int pendingTaps;
    private Runnable pendingHold;
    private Runnable pendingTapResolve;

    MoaRibbonTouchListener(Context context, MoaRibbonView ribbon, Callbacks callbacks) {
        this.ribbon = ribbon;
        this.callbacks = callbacks;
        this.touchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
    }

    @Override
    public boolean onTouch(View view, MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                if (!ribbon.hitsInteractive(event.getX(), event.getY())) {
                    owned = false;
                    return false;
                }
                owned = true;
                downX = event.getRawX();
                downY = event.getRawY();
                dragging = false;
                holdFired = false;
                railPress = ribbon.hitsRail(event.getX(), event.getY());
                historyPress = ribbon.hitsHistory(event.getX(), event.getY());
                callbacks.onPressChanged(true);
                scheduleHold(view);
                return true;
            case MotionEvent.ACTION_MOVE: {
                if (!owned) {
                    return false;
                }
                int dx = Math.round(event.getRawX() - downX);
                int dy = Math.round(event.getRawY() - downY);
                if (!dragging && (Math.abs(dx) > touchSlop || Math.abs(dy) > touchSlop)) {
                    dragging = true;
                    cancelHold();
                    cancelTapResolve();
                    pendingTaps = 0;
                    callbacks.onDragStart();
                }
                if (dragging) {
                    callbacks.onDragMove(dx, dy);
                }
                return true;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL: {
                if (!owned) {
                    return false;
                }
                owned = false;
                cancelHold();
                callbacks.onPressChanged(false);
                boolean committed = event.getActionMasked() == MotionEvent.ACTION_UP;
                if (dragging) {
                    dragging = false;
                    callbacks.onDragEnd(committed);
                    return true;
                }
                if (holdFired || !committed) {
                    return true;
                }
                if (historyPress) {
                    historyPress = false;
                    callbacks.onHistory();
                    return true;
                }
                if (railPress) {
                    railPress = false;
                    callbacks.onCopy();
                    return true;
                }
                pendingTaps++;
                scheduleTapResolve();
                return true;
            }
            default:
                return owned;
        }
    }

    private void scheduleHold(View view) {
        cancelHold();
        pendingHold = () -> {
            pendingHold = null;
            if (dragging) {
                return;
            }
            holdFired = true;
            cancelTapResolve();
            pendingTaps = 0;
            view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
            callbacks.onHold();
        };
        handler.postDelayed(pendingHold, MoaRibbonTokens.HOLD_MS);
    }

    private void cancelHold() {
        if (pendingHold != null) {
            handler.removeCallbacks(pendingHold);
            pendingHold = null;
        }
    }

    private void scheduleTapResolve() {
        cancelTapResolve();
        pendingTapResolve = () -> {
            pendingTapResolve = null;
            int taps = pendingTaps;
            pendingTaps = 0;
            if (taps == 1) {
                callbacks.onTap();
            } else if (taps == 2) {
                callbacks.onDoubleTap();
            }
            // A third tap is absorbed on purpose; the ribbon has no triple action.
        };
        handler.postDelayed(pendingTapResolve, MoaRibbonTokens.MULTITAP_MS);
    }

    private void cancelTapResolve() {
        if (pendingTapResolve != null) {
            handler.removeCallbacks(pendingTapResolve);
            pendingTapResolve = null;
        }
    }

    void release() {
        cancelHold();
        cancelTapResolve();
    }
}
