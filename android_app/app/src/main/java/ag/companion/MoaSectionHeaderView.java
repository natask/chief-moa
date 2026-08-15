package ag.companion;

import android.content.Context;
import android.graphics.Typeface;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

final class MoaSectionHeaderView {
    private MoaSectionHeaderView() { }

    static View create(Context context, String title, String description) {
        LinearLayout intro = new LinearLayout(context);
        intro.setOrientation(LinearLayout.VERTICAL);
        TextView heading = text(context, title, MoaColors.PAPER, 26, true);
        heading.setPadding(0, dp(context, 18), 0, dp(context, 6));
        intro.addView(heading);
        TextView detail = text(context, description, MoaColors.MUTED, 15, false);
        detail.setLineSpacing(dp(context, 3), 1f);
        intro.addView(detail);
        return intro;
    }

    private static TextView text(Context context, String value, int color, int size, boolean bold) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(size);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
