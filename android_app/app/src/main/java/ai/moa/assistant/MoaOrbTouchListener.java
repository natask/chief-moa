package ai.moa.assistant;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;

// Orb gestures, matched to the browser extension's mark:
//   single tap  -> onSingleTap, text mode (open the keyboard / panel)
//   double tap  -> onDoubleTap, voice mode (continuous listen/reply loop)
//   long press  -> onLongPressStart / onLongPressRelease, push-to-talk
//   drag        -> reposition the orb, no callback
// A single tap is confirmed only after the double-tap window passes, so a tap
// never flashes the text surface before a double tap engages voice.
final class MoaOrbTouchListener implements View.OnTouchListener {
    private static final long PUSH_TO_TALK_HOLD_MS = 120;

    private final Context context;
    private final WindowManager windowManager;
    private final OrbView orbView;
    private final WindowManager.LayoutParams orbParams;
    private final int orbWindowDp;
    private final int edgeMarginDp;
    private final Runnable onLongPressStart;
    private final Runnable onLongPressRelease;
    private final GestureDetector gestureDetector;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private int startX;
    private int startY;
    private float downX;
    private float downY;
    private boolean moved;
    private boolean longPressActive;
    private boolean suppressTapAfterLongPress;
    private Runnable pendingLongPressStart;

    MoaOrbTouchListener(
            Context context,
            WindowManager windowManager,
            OrbView orbView,
            WindowManager.LayoutParams orbParams,
            int orbWindowDp,
            int edgeMarginDp,
            Runnable onSingleTap,
            Runnable onDoubleTap,
            Runnable onLongPressStart,
            Runnable onLongPressRelease
    ) {
        this.context = context;
        this.windowManager = windowManager;
        this.orbView = orbView;
        this.orbParams = orbParams;
        this.orbWindowDp = orbWindowDp;
        this.edgeMarginDp = edgeMarginDp;
        this.onLongPressStart = onLongPressStart;
        this.onLongPressRelease = onLongPressRelease;
        this.gestureDetector = new GestureDetector(context, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onSingleTapConfirmed(MotionEvent e) {
                if (!moved && !longPressActive && !suppressTapAfterLongPress) {
                    onSingleTap.run();
                }
                suppressTapAfterLongPress = false;
                return true;
            }

            @Override
            public boolean onDoubleTap(MotionEvent e) {
                if (!moved) {
                    onDoubleTap.run();
                }
                return true;
            }

            @Override
            public void onLongPress(MotionEvent e) {
                // The platform long-press delay is too slow for push-to-talk.
                // ACTION_DOWN schedules our shorter hold threshold instead.
            }
        });
    }

    @Override
    public boolean onTouch(View view, MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            cancelPendingLongPress();
            startX = orbParams.x;
            startY = orbParams.y;
            downX = event.getRawX();
            downY = event.getRawY();
            moved = false;
            longPressActive = false;
            suppressTapAfterLongPress = false;
            pendingLongPressStart = () -> {
                pendingLongPressStart = null;
                if (!moved && !longPressActive) {
                    longPressActive = true;
                    suppressTapAfterLongPress = true;
                    onLongPressStart.run();
                }
            };
            mainHandler.postDelayed(pendingLongPressStart, PUSH_TO_TALK_HOLD_MS);
        }

        gestureDetector.onTouchEvent(event);
        switch (action) {
            case MotionEvent.ACTION_DOWN:
                return true;
            case MotionEvent.ACTION_MOVE:
                if (longPressActive) {
                    return true;
                }
                int dx = Math.round(event.getRawX() - downX);
                int dy = Math.round(event.getRawY() - downY);
                if (Math.abs(dx) > dp(5) || Math.abs(dy) > dp(5)) {
                    moved = true;
                    cancelPendingLongPress();
                }
                orbParams.x = clampOrbX(startX + dx);
                orbParams.y = clampOrbY(startY + dy);
                windowManager.updateViewLayout(orbView, orbParams);
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                cancelPendingLongPress();
                if (longPressActive) {
                    longPressActive = false;
                    onLongPressRelease.run();
                }
                return true;
            default:
                return false;
        }
    }

    private void cancelPendingLongPress() {
        if (pendingLongPressStart == null) {
            return;
        }
        mainHandler.removeCallbacks(pendingLongPressStart);
        pendingLongPressStart = null;
    }

    private int clampOrbX(int value) {
        int margin = dp(edgeMarginDp);
        int max = context.getResources().getDisplayMetrics().widthPixels - dp(orbWindowDp) - margin;
        return Math.max(margin, Math.min(value, max));
    }

    private int clampOrbY(int value) {
        int margin = dp(edgeMarginDp);
        int max = context.getResources().getDisplayMetrics().heightPixels - dp(orbWindowDp) - margin;
        return Math.max(margin, Math.min(value, max));
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
