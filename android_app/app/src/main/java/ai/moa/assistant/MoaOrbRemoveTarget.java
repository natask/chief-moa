package ai.moa.assistant;

import android.content.Context;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

/**
 * The drag-to-remove target, and the undo chip that makes hitting it recoverable.
 *
 * The target used to be a 150x58dp pill with a 270x170dp invisible hit zone
 * around it — reported as both too small to aim at and too sensitive to avoid.
 * Both halves are fixed here: the pill is larger, and
 * {@link MoaOrbOverlayGeometry#isInRemoveTarget} now tests the painted rectangle
 * plus one small tolerance, so what arms removal is what the user can see.
 */
final class MoaOrbRemoveTarget {
    static final int WIDTH_DP = 200;
    static final int HEIGHT_DP = 72;
    static final int BOTTOM_INSET_DP = 34;
    /** Slack around the painted rectangle. Small on purpose. */
    static final int TOLERANCE_DP = 12;

    private MoaOrbRemoveTarget() {
    }

    static TextView show(Context context, WindowManager windowManager, int overlayType) {
        TextView target = new TextView(context);
        target.setText("Drop here to remove");
        target.setTextColor(MoaColors.MUTED);
        target.setTextSize(14);
        target.setTypeface(Typeface.DEFAULT_BOLD);
        target.setGravity(Gravity.CENTER);
        target.setBackground(MoaDrawables.rounded(
                0xF01B1C20, dp(context, 28), MoaColors.PANEL_BORDER, dp(context, 1)));
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                dp(context, WIDTH_DP), dp(context, HEIGHT_DP), overlayType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.y = Math.max(
                dp(context, 12),
                context.getResources().getDisplayMetrics().heightPixels
                        - dp(context, HEIGHT_DP) - dp(context, BOTTOM_INSET_DP));
        windowManager.addView(target, params);
        target.setAlpha(0f);
        target.setScaleX(0.9f);
        target.setScaleY(0.9f);
        target.animate().alpha(0.34f).scaleX(1f).scaleY(1f).setDuration(140).start();
        return target;
    }

    static void update(Context context, TextView target, boolean active) {
        target.setText(active ? "Release to remove" : "Drop here to remove");
        target.setTextColor(active ? MoaColors.PAPER : MoaColors.MUTED);
        target.setBackground(MoaDrawables.rounded(
                active ? 0xF0B3261E : 0xF01B1C20,
                dp(context, 28), active ? 0x80FF8A80 : MoaColors.PANEL_BORDER,
                dp(context, 1)));
        target.animate().alpha(active ? 1f : 0.34f)
                .scaleX(active ? 1.08f : 1f).scaleY(active ? 1.08f : 1f)
                .setDuration(100).start();
    }

    /**
     * The one affordance left on screen after a removal. Tapping it restores the
     * companion where the drag started; ignoring it lets the service stop.
     */
    static View undoChip(
            Context context, WindowManager windowManager, int overlayType, Runnable onUndo) {
        TextView chip = new TextView(context);
        chip.setText("Overlay removed  ·  UNDO");
        chip.setTextColor(MoaColors.PAPER);
        chip.setTextSize(13);
        chip.setTypeface(Typeface.DEFAULT_BOLD);
        chip.setGravity(Gravity.CENTER);
        chip.setContentDescription("Undo removing the A.G. overlay");
        chip.setBackground(MoaDrawables.rounded(
                0xF01B1C20, dp(context, 24), MoaColors.PANEL_BORDER, dp(context, 1)));
        chip.setOnClickListener(v -> onUndo.run());
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                dp(context, 240), dp(context, 48), overlayType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.y = Math.max(
                dp(context, 12),
                context.getResources().getDisplayMetrics().heightPixels
                        - dp(context, 48) - dp(context, BOTTOM_INSET_DP));
        windowManager.addView(chip, params);
        chip.setAlpha(0f);
        chip.animate().alpha(1f).setDuration(140).start();
        return chip;
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
