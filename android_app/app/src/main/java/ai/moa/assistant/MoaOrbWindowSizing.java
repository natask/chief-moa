package ai.moa.assistant;

import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

/** Owns the Android window geometry needed to create and live-resize the orb. */
final class MoaOrbWindowSizing {
    private MoaOrbWindowSizing() {
    }

    static WindowManager.LayoutParams initialParams(
            Context context, int size, int overlayType, int edgeMarginDp) {
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                size,
                size,
                overlayType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                android.graphics.PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = context.getResources().getDisplayMetrics().widthPixels
                - size - dp(context, edgeMarginDp);
        params.y = dp(context, 164);
        return params;
    }

    static void resize(
            Context context,
            WindowManager windowManager,
            View orb,
            WindowManager.LayoutParams params,
            int size,
            int edgeMarginDp
    ) {
        params.width = size;
        params.height = size;
        int margin = dp(context, edgeMarginDp);
        params.x = MoaOrbPresentation.clampWindowPosition(
                params.x, context.getResources().getDisplayMetrics().widthPixels, size, margin);
        params.y = MoaOrbPresentation.clampWindowPosition(
                params.y, context.getResources().getDisplayMetrics().heightPixels, size, margin);
        MoaOverlayWindowLayout.update(windowManager, orb, params);
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
