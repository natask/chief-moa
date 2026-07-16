package ai.moa.assistant;

import android.view.View;
import android.view.WindowManager;

final class MoaOverlayWindowLayout {
    private MoaOverlayWindowLayout() {
    }

    static void positionAnchored(
            WindowManager windowManager,
            View surface,
            WindowManager.LayoutParams params,
            int screenWidth,
            int screenHeight,
            int margin,
            int gap,
            int orbX,
            int orbY,
            int orbSize,
            int surfaceWidth,
            int fallbackHeight
    ) {
        if (surface == null || params == null) {
            return;
        }
        int height = surface.getMeasuredHeight() > 0 ? surface.getMeasuredHeight() : fallbackHeight;
        MoaOrbOverlayGeometry.Position position = MoaOrbOverlayGeometry.anchoredSurface(
                screenWidth, screenHeight, margin, gap, orbX, orbY, orbSize, surfaceWidth, height);
        params.x = position.x;
        params.y = position.y;
        update(windowManager, surface, params);
    }

    static void update(
            WindowManager windowManager,
            View view,
            WindowManager.LayoutParams params
    ) {
        if (view == null || params == null || view.getParent() == null) {
            return;
        }
        try {
            windowManager.updateViewLayout(view, params);
        } catch (IllegalArgumentException ignored) {
            // The window was detached before this display-frame update applied.
        }
    }
}
