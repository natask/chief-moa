package ai.moa.assistant;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;

/**
 * Ribbon gestures, sharing slop and hold thresholds with the companion so the
 * unit feels like one object.
 *
 * <pre>
 *   tap             expand or collapse the bubble (fires on UP, no multi-tap wait)
 *   tap on Copy     copy the FULL buffer — the one copy affordance
 *   tap on History  open History, which is a separate surface
 *   hold            open the ribbon menu (reply-side utilities only)
 *   vertical drag   inside an overflowing expanded bubble: scroll the content
 *   drag            otherwise: move the whole unit; the anchor is the companion
 * </pre>
 *
 * A drag past slop cancels the pending hold, matching the companion's existing
 * "large movement escapes into drag" rule. There is deliberately no double-tap:
 * a second action must be a second visible button, never a hidden gesture.
 *
 * Touches that do not land on the bubble are not taken at all
 * ({@link MoaRibbonView#hitsInteractive}), so an empty ribbon is inert.
 */
final class MoaRibbonTouchListener implements View.OnTouchListener {
    interface Callbacks {
        void onPressChanged(boolean down);

        void onTap();

        void onCopy();

        void onHistory();

        void onHold();

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
    private float lastY;
    private boolean dragging;
    private boolean scrolling;
    private boolean holdFired;
    private boolean railPress;
    private boolean historyPress;
    private boolean owned;
    private Runnable pendingHold;

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
                lastY = event.getRawY();
                dragging = false;
                scrolling = false;
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
                if (!dragging && !scrolling
                        && (Math.abs(dx) > touchSlop || Math.abs(dy) > touchSlop)) {
                    cancelHold();
                    // A mostly-vertical pull inside an overflowing expanded
                    // bubble reads the text; anything else moves the unit.
                    if (ribbon.canScrollExpanded() && Math.abs(dy) > Math.abs(dx)) {
                        scrolling = true;
                    } else {
                        dragging = true;
                        callbacks.onDragStart();
                    }
                }
                if (scrolling) {
                    ribbon.scrollExpandedBy(event.getRawY() - lastY);
                } else if (dragging) {
                    callbacks.onDragMove(dx, dy);
                }
                lastY = event.getRawY();
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
                if (scrolling) {
                    scrolling = false;
                    return true;
                }
                if (holdFired || !committed) {
                    return true;
                }
                if (historyPress && ribbon.hitsHistory(event.getX(), event.getY())) {
                    historyPress = false;
                    callbacks.onHistory();
                    return true;
                }
                if (railPress && ribbon.hitsRail(event.getX(), event.getY())) {
                    railPress = false;
                    callbacks.onCopy();
                    return true;
                }
                // A button press released outside its button is canceled; it
                // must not fall through and expand the bubble instead.
                if (historyPress || railPress) {
                    historyPress = false;
                    railPress = false;
                    return true;
                }
                callbacks.onTap();
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
            if (dragging || scrolling) {
                return;
            }
            holdFired = true;
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

    void release() {
        cancelHold();
    }
}
