package ai.moa.assistant;

import android.view.WindowManager;

/** Remembers the last layout submitted for one overlay window. */
final class MoaWindowLayoutState {
    private boolean submitted;
    private int x;
    private int y;
    private int width;
    private int height;
    private int flags;

    boolean changed(WindowManager.LayoutParams params) {
        if (submitted
                && x == params.x
                && y == params.y
                && width == params.width
                && height == params.height
                && flags == params.flags) {
            return false;
        }
        submitted = true;
        x = params.x;
        y = params.y;
        width = params.width;
        height = params.height;
        flags = params.flags;
        return true;
    }

    void reset() {
        submitted = false;
    }
}
