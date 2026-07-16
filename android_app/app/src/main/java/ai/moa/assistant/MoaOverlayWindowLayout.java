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
            View orb,
            WindowManager.LayoutParams orbParams,
            int orbSize,
            int surfaceWidth,
            int fallbackHeight
    ) {
        if (surface == null || params == null || orbParams == null) {
            return;
        }
        int height = surface.getMeasuredHeight() > 0 ? surface.getMeasuredHeight() : fallbackHeight;
        MoaOrbOverlayGeometry.Position position = MoaOrbOverlayGeometry.anchoredSurface(
                screenWidth, screenHeight, margin, gap, orbParams.x, orbParams.y, orbSize, surfaceWidth, height);
        if (position.orbY != orbParams.y) {
            // Always-above rule: the orb yields (moves down) so the whole card
            // plus gap stays on-screen above it.
            orbParams.y = position.orbY;
            update(windowManager, orb, orbParams);
        }
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
