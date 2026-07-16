package ai.moa.assistant;

import android.content.Context;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Factory for the small overlay controls that accept or cancel a reviewable voice draft. */
final class MoaVoiceDraftControls {
    private MoaVoiceDraftControls() {}

    static TextView create(
            Context context,
            String glyph,
            String description,
            boolean affirmative,
            int size,
            int strokeWidth
    ) {
        TextView control = new TextView(context);
        control.setText(glyph);
        control.setContentDescription(description);
        control.setTextSize(affirmative ? 25 : 24);
        control.setTypeface(Typeface.DEFAULT_BOLD);
        control.setGravity(Gravity.CENTER);
        control.setTextColor(affirmative ? MoaColors.INK : MoaColors.PAPER);
        control.setBackground(MoaDrawables.circlePressable(
                affirmative ? MoaColors.GOLD : 0x24FFFFFF,
                affirmative ? MoaColors.AMBER : 0x3AFFFFFF,
                affirmative ? 0x33FFFFFF : MoaColors.PANEL_BORDER,
                strokeWidth
        ));
        control.setLayoutParams(new LinearLayout.LayoutParams(size, size));
        return control;
    }

    static WindowManager.LayoutParams windowParams(int size, int overlayType) {
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                size,
                size,
                overlayType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.START;
        return params;
    }
}
