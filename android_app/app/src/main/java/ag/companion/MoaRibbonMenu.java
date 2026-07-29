package ag.companion;

import android.content.Context;
import android.graphics.PixelFormat;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

/**
 * The hold menu: at most four rows, no submenus, no scrolling.
 *
 * Every row is inert in the product sense — none of them takes a model action,
 * launches a run, or changes a setting. Settings are reachable only through the
 * agent's own capability, never from the overlay.
 */
final class MoaRibbonMenu {
    static final class Row {
        final String label;
        final boolean enabled;
        final Runnable action;

        Row(String label, boolean enabled, Runnable action) {
            this.label = label;
            this.enabled = enabled;
            this.action = action;
        }

        static Row of(String label, Runnable action) {
            return new Row(label, true, action);
        }

        static Row disabled(String label) {
            return new Row(label, false, null);
        }
    }

    private MoaRibbonMenu() {
    }

    /**
     * @param anchorX left edge of the held ribbon
     * @param anchorY top edge of the held ribbon
     */
    static View show(
            Context context,
            WindowManager windowManager,
            int overlayType,
            MoaRibbonTokens.Palette palette,
            List<Row> rows,
            int anchorX,
            int anchorY,
            int ribbonHeight,
            Runnable onDismiss
    ) {
        float density = context.getResources().getDisplayMetrics().density;
        int width = dp(density, MoaRibbonTokens.MENU_W_DP);
        int rowHeight = dp(density, MoaRibbonTokens.MENU_ROW_H_DP);
        int padding = dp(density, 6);
        int visibleRows = Math.min(rows.size(), 4);

        LinearLayout menu = new LinearLayout(context);
        menu.setOrientation(LinearLayout.VERTICAL);
        menu.setPadding(0, padding, 0, padding);
        menu.setBackground(MoaDrawables.rounded(
                palette.menuBg, dp(density, MoaRibbonTokens.RADIUS_MENU_DP),
                palette.hairline, Math.max(1, dp(density, MoaRibbonTokens.HAIRLINE_DP))));
        menu.setElevation(dp(density, 18));

        for (int i = 0; i < visibleRows; i++) {
            Row row = rows.get(i);
            TextView item = new TextView(context);
            item.setText(row.label);
            item.setTextSize(MoaRibbonTokens.MENU_TEXT_SP);
            item.setTextColor(row.enabled ? palette.ink : palette.muted);
            item.setGravity(Gravity.CENTER_VERTICAL);
            item.setPadding(dp(density, 14), 0, dp(density, 14), 0);
            item.setEnabled(row.enabled);
            if (row.enabled && row.action != null) {
                item.setOnClickListener(v -> {
                    row.action.run();
                    onDismiss.run();
                });
            }
            menu.addView(item, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, rowHeight));
        }

        int height = visibleRows * rowHeight + padding * 2;
        int screenWidth = context.getResources().getDisplayMetrics().widthPixels;
        int screenHeight = context.getResources().getDisplayMetrics().heightPixels;
        int margin = dp(density, MoaRibbonTokens.EDGE_MARGIN_DP);

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                width, height, overlayType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = clamp(anchorX, margin, Math.max(margin, screenWidth - width - margin));
        // Prefer below the held ribbon, flip above when that would leave the screen.
        int below = anchorY + ribbonHeight + dp(density, 6);
        params.y = below + height > screenHeight - margin
                ? Math.max(margin, anchorY - height - dp(density, 6))
                : below;

        menu.setOnTouchListener((view, event) -> {
            if (event.getActionMasked() == MotionEvent.ACTION_OUTSIDE) {
                onDismiss.run();
                return true;
            }
            return false;
        });

        windowManager.addView(menu, params);
        menu.setAlpha(0f);
        menu.setScaleX(0.96f);
        menu.setScaleY(0.96f);
        menu.animate().alpha(1f).scaleX(1f).scaleY(1f)
                .setDuration(MoaRibbonTokens.DUR_MENU_MS).start();
        return menu;
    }

    private static int dp(float density, float value) {
        return Math.round(value * density);
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(value, max));
    }
}
