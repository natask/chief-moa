package ai.moa.assistant;

import android.content.Context;
import android.os.Handler;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;

// Push-to-talk orb gestures:
//   hold (press past HOLD_MS, no drag) -> onHoldStart, begin speaking
//   release after a hold              -> onHoldRelease, send what was heard
//   quick tap (release before HOLD_MS) -> onSingleTap, open the keyboard
//   drag                              -> reposition the orb, no callback
final class MoaOrbTouchListener implements View.OnTouchListener {
    // How long a press must be held before it engages voice. Shorter than the
    // platform long-press so push-to-talk feels immediate, long enough that a
    // normal tap never trips it.
    private static final long HOLD_MS = 240;

    private final Context context;
    private final Handler mainHandler;
    private final WindowManager windowManager;
    private final OrbView orbView;
    private final WindowManager.LayoutParams orbParams;
    private final Runnable onSingleTap;
    private final Runnable onHoldStart;
    private final Runnable onHoldRelease;
    private final int orbWindowDp;
    private final int edgeMarginDp;

    private int startX;
    private int startY;
    private float downX;
    private float downY;
    private boolean moved;
    private boolean holdStarted;
    private Runnable pendingHold;

    MoaOrbTouchListener(
            Context context,
            Handler mainHandler,
            WindowManager windowManager,
            OrbView orbView,
            WindowManager.LayoutParams orbParams,
            int orbWindowDp,
            int edgeMarginDp,
            Runnable onSingleTap,
            Runnable onHoldStart,
            Runnable onHoldRelease
    ) {
        this.context = context;
        this.mainHandler = mainHandler;
        this.windowManager = windowManager;
        this.orbView = orbView;
        this.orbParams = orbParams;
        this.orbWindowDp = orbWindowDp;
        this.edgeMarginDp = edgeMarginDp;
        this.onSingleTap = onSingleTap;
        this.onHoldStart = onHoldStart;
        this.onHoldRelease = onHoldRelease;
    }

    @Override
    public boolean onTouch(View view, MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                cancelPendingHold();
                startX = orbParams.x;
                startY = orbParams.y;
                downX = event.getRawX();
                downY = event.getRawY();
                moved = false;
                holdStarted = false;
                pendingHold = () -> {
                    pendingHold = null;
                    holdStarted = true;
                    onHoldStart.run();
                };
                mainHandler.postDelayed(pendingHold, HOLD_MS);
                return true;
            case MotionEvent.ACTION_MOVE:
                // Once speaking, ignore movement so the orb stays put while held.
                if (holdStarted) {
                    return true;
                }
                int dx = Math.round(event.getRawX() - downX);
                int dy = Math.round(event.getRawY() - downY);
                if (Math.abs(dx) > dp(5) || Math.abs(dy) > dp(5)) {
                    moved = true;
                    cancelPendingHold();
                }
                orbParams.x = clampOrbX(startX + dx);
                orbParams.y = clampOrbY(startY + dy);
                windowManager.updateViewLayout(orbView, orbParams);
                return true;
            case MotionEvent.ACTION_UP:
                cancelPendingHold();
                if (holdStarted) {
                    onHoldRelease.run();
                } else if (!moved) {
                    onSingleTap.run();
                }
                return true;
            case MotionEvent.ACTION_CANCEL:
                cancelPendingHold();
                // A held turn interrupted by the system still sends what was heard.
                if (holdStarted) {
                    onHoldRelease.run();
                }
                return true;
            default:
                return false;
        }
    }

    private void cancelPendingHold() {
        if (pendingHold != null) {
            mainHandler.removeCallbacks(pendingHold);
            pendingHold = null;
        }
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
