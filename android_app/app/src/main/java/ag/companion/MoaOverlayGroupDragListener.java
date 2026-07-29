package ag.companion;

import android.content.Context;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;

/** Moves the orb and its anchored overlay surfaces from a shared surface header. */
final class MoaOverlayGroupDragListener implements View.OnTouchListener {
    private final Context context;
    private final WindowManager.LayoutParams orbParams;
    private final int fallbackOrbSize;
    private final int edgeMargin;
    private final int touchSlop;
    private final Runnable onDragStarted;
    private final Runnable onMoved;
    private float downX;
    private float downY;
    private int startX;
    private int startY;
    private boolean dragging;

    MoaOverlayGroupDragListener(
            Context context,
            WindowManager.LayoutParams orbParams,
            int fallbackOrbSize,
            int edgeMargin,
            Runnable onDragStarted,
            Runnable onMoved
    ) {
        this.context = context;
        this.orbParams = orbParams;
        this.fallbackOrbSize = fallbackOrbSize;
        this.edgeMargin = edgeMargin;
        this.touchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
        this.onDragStarted = onDragStarted;
        this.onMoved = onMoved;
    }

    @Override
    public boolean onTouch(View view, MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = event.getRawX();
                downY = event.getRawY();
                startX = orbParams.x;
                startY = orbParams.y;
                dragging = false;
                return true;
            case MotionEvent.ACTION_MOVE:
                int dx = Math.round(event.getRawX() - downX);
                int dy = Math.round(event.getRawY() - downY);
                if (!dragging && (Math.abs(dx) > touchSlop || Math.abs(dy) > touchSlop)) {
                    dragging = true;
                    onDragStarted.run();
                }
                if (!dragging) return true;
                int size = orbParams.width > 0 ? orbParams.width : fallbackOrbSize;
                int screenWidth = context.getResources().getDisplayMetrics().widthPixels;
                int screenHeight = context.getResources().getDisplayMetrics().heightPixels;
                orbParams.x = clamp(startX + dx, edgeMargin, screenWidth - size - edgeMargin);
                orbParams.y = clamp(startY + dy, edgeMargin, screenHeight - size - edgeMargin);
                // Record only the latest anchor. The shared display-frame
                // coalescer submits the orb and every anchored surface once.
                onMoved.run();
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                return dragging;
            default:
                return false;
        }
    }

    private static int clamp(int value, int minimum, int maximum) {
        return Math.max(minimum, Math.min(value, maximum));
    }
}
