package ai.moa.assistant;

import android.content.Context;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;

// Orb gestures, matched to the browser extension's mark:
//   single tap  -> onSingleTap, text mode (open the keyboard / panel)
//   double tap  -> onDoubleTap, voice mode (continuous listen/reply loop)
//   drag        -> reposition the orb, no callback
// A single tap is confirmed only after the double-tap window passes, so a tap
// never flashes the text surface before a double tap engages voice.
final class MoaOrbTouchListener implements View.OnTouchListener {
    private final Context context;
    private final WindowManager windowManager;
    private final OrbView orbView;
    private final WindowManager.LayoutParams orbParams;
    private final int orbWindowDp;
    private final int edgeMarginDp;
    private final GestureDetector gestureDetector;

    private int startX;
    private int startY;
    private float downX;
    private float downY;
    private boolean moved;

    MoaOrbTouchListener(
            Context context,
            WindowManager windowManager,
            OrbView orbView,
            WindowManager.LayoutParams orbParams,
            int orbWindowDp,
            int edgeMarginDp,
            Runnable onSingleTap,
            Runnable onDoubleTap
    ) {
        this.context = context;
        this.windowManager = windowManager;
        this.orbView = orbView;
        this.orbParams = orbParams;
        this.orbWindowDp = orbWindowDp;
        this.edgeMarginDp = edgeMarginDp;
        this.gestureDetector = new GestureDetector(context, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onSingleTapConfirmed(MotionEvent e) {
                if (!moved) {
                    onSingleTap.run();
                }
                return true;
            }

            @Override
            public boolean onDoubleTap(MotionEvent e) {
                if (!moved) {
                    onDoubleTap.run();
                }
                return true;
            }
        });
    }

    @Override
    public boolean onTouch(View view, MotionEvent event) {
        gestureDetector.onTouchEvent(event);
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                startX = orbParams.x;
                startY = orbParams.y;
                downX = event.getRawX();
                downY = event.getRawY();
                moved = false;
                return true;
            case MotionEvent.ACTION_MOVE:
                int dx = Math.round(event.getRawX() - downX);
                int dy = Math.round(event.getRawY() - downY);
                if (Math.abs(dx) > dp(5) || Math.abs(dy) > dp(5)) {
                    moved = true;
                }
                orbParams.x = clampOrbX(startX + dx);
                orbParams.y = clampOrbY(startY + dy);
                windowManager.updateViewLayout(orbView, orbParams);
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                return true;
            default:
                return false;
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
