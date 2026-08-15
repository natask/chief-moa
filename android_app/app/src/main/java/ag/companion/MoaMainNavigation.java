package ag.companion;

import android.content.Context;
import android.graphics.PorterDuff;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Quiet, thumb-reachable navigation with a real icon and label for every destination. */
final class MoaMainNavigation {
    static final int TALK = 0;
    static final int WORK = 1;
    static final int RELEASES = 2;
    static final int SETTINGS = 3;

    interface Listener { void onDestinationSelected(int destination); }

    private static final int[] ICONS = {
            R.drawable.ic_nav_talk, R.drawable.ic_nav_work,
            R.drawable.ic_nav_releases, R.drawable.ic_nav_settings
    };
    private static final String[] LABELS = {"Talk", "Work", "Releases", "Settings"};

    private final Context context;
    private final Listener listener;
    private final LinearLayout[] items = new LinearLayout[4];
    private final ImageView[] icons = new ImageView[4];
    private final TextView[] labels = new TextView[4];

    MoaMainNavigation(Context context, Listener listener) {
        this.context = context;
        this.listener = listener;
    }

    View createView() {
        LinearLayout bar = new LinearLayout(context);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER);
        bar.setPadding(dp(10), dp(8), dp(10), dp(8));
        bar.setBackground(MoaDrawables.roundedGradient(
                0xFC111114, 0xFF0B0B0D, 0, MoaColors.PANEL_BORDER, dp(1)));
        bar.setElevation(dp(18));
        for (int destination = 0; destination < LABELS.length; destination++) add(bar, destination);
        select(TALK);
        return bar;
    }

    void select(int destination) {
        for (int index = 0; index < items.length; index++) {
            if (items[index] == null) continue;
            boolean selected = index == destination;
            items[index].setBackground(MoaDrawables.rounded(
                    selected ? MoaColors.GOLD_WASH : 0x00000000, dp(16),
                    selected ? MoaColors.GOLD_BORDER : 0x00000000, selected ? dp(1) : 0));
            icons[index].setColorFilter(selected ? MoaColors.GOLD_BRIGHT : MoaColors.MUTED_DARK,
                    PorterDuff.Mode.SRC_IN);
            labels[index].setTextColor(selected ? MoaColors.PAPER : MoaColors.MUTED);
            items[index].setContentDescription(LABELS[index] + (selected ? ", selected" : ", tab"));
            items[index].setSelected(selected);
        }
    }

    private void add(LinearLayout bar, int destination) {
        LinearLayout item = new LinearLayout(context);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setGravity(Gravity.CENTER);
        item.setPadding(dp(4), dp(7), dp(4), dp(6));
        item.setClickable(true);
        item.setFocusable(true);
        item.setOnClickListener(view -> listener.onDestinationSelected(destination));
        if (destination == SETTINGS) item.setId(R.id.moa_settings_nav_target);

        ImageView icon = new ImageView(context);
        icon.setImageResource(ICONS[destination]);
        item.addView(icon, new LinearLayout.LayoutParams(dp(22), dp(22)));

        TextView label = new TextView(context);
        label.setText(LABELS[destination]);
        label.setTextSize(11);
        label.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        label.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        labelParams.topMargin = dp(3);
        item.addView(label, labelParams);

        items[destination] = item;
        icons[destination] = icon;
        labels[destination] = label;
        bar.addView(item, new LinearLayout.LayoutParams(0, dp(58), 1f));
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
