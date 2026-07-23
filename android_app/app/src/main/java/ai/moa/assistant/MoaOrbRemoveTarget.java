package ai.moa.assistant;

import android.content.Context;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.TextView;

final class MoaOrbRemoveTarget {
    private MoaOrbRemoveTarget() {
    }

    static TextView show(Context context, WindowManager windowManager, int overlayType) {
        TextView target = new TextView(context);
        target.setText("Remove orb");
        target.setTextColor(MoaColors.MUTED);
        target.setTextSize(14);
        target.setTypeface(Typeface.DEFAULT_BOLD);
        target.setGravity(Gravity.CENTER);
        target.setBackground(MoaDrawables.rounded(
                0xF01B1C20, dp(context, 28), MoaColors.PANEL_BORDER, dp(context, 1)));
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                dp(context, 150), dp(context, 58), overlayType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.y = Math.max(
                dp(context, 12),
                context.getResources().getDisplayMetrics().heightPixels
                        - dp(context, 58) - dp(context, 34));
        windowManager.addView(target, params);
        target.setAlpha(0f);
        target.setScaleX(0.9f);
        target.setScaleY(0.9f);
        target.animate().alpha(0.10f).scaleX(1f).scaleY(1f).setDuration(140).start();
        return target;
    }

    static void update(Context context, TextView target, boolean active) {
        target.setText(active ? "Release to remove" : "Remove orb");
        target.setTextColor(active ? MoaColors.PAPER : MoaColors.MUTED);
        target.setBackground(MoaDrawables.rounded(
                active ? 0xF0B3261E : 0xF01B1C20,
                dp(context, 28), active ? 0x80FF8A80 : MoaColors.PANEL_BORDER,
                dp(context, 1)));
        target.animate().alpha(active ? 1f : 0.10f)
                .scaleX(active ? 1.08f : 1f).scaleY(active ? 1.08f : 1f)
                .setDuration(100).start();
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
