package ai.moa.assistant;

import android.content.Context;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

final class MoaTextViews {
    private MoaTextViews() {
    }

    static TextView pill(Context context, String value, int background, int foreground) {
        TextView pill = text(context, value, foreground, 11, true);
        pill.setGravity(Gravity.CENTER);
        pill.setPadding(dp(context, 10), dp(context, 5), dp(context, 10), dp(context, 5));
        pill.setBackground(MoaDrawables.rounded(background, dp(context, 999), 0x10FFFFFF, dp(context, 1)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.rightMargin = dp(context, 6);
        pill.setLayoutParams(params);
        return pill;
    }

    static TextView text(Context context, String value, int color, int sp, boolean bold) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(sp);
        if (bold) {
            view.setTypeface(Typeface.DEFAULT_BOLD);
        }
        return view;
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
