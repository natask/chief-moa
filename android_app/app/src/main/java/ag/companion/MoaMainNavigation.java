package ag.companion;

import android.content.Context;
import android.graphics.Typeface;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;

/** Four-destination app navigation. Keeps developer controls out of the home surface. */
final class MoaMainNavigation {
    static final int TALK = 0;
    static final int WORK = 1;
    static final int RELEASES = 2;
    static final int SETTINGS = 3;

    interface Listener { void onDestinationSelected(int destination); }

    private final Context context;
    private final Listener listener;
    private final Button[] buttons = new Button[4];

    MoaMainNavigation(Context context, Listener listener) {
        this.context = context;
        this.listener = listener;
    }

    View createView() {
        LinearLayout rail = new LinearLayout(context);
        rail.setOrientation(LinearLayout.HORIZONTAL);
        rail.setPadding(dp(12), dp(8), dp(12), dp(10));
        rail.setBackground(MoaDrawables.roundedGradient(
                MoaColors.PANEL_BG, MoaColors.SURFACE_0, 0,
                MoaColors.PANEL_BORDER, dp(1)));
        add(rail, TALK, "Talk");
        add(rail, WORK, "Work");
        add(rail, RELEASES, "Releases");
        add(rail, SETTINGS, "Settings");
        select(TALK);
        return rail;
    }

    void select(int destination) {
        for (int index = 0; index < buttons.length; index++) {
            Button button = buttons[index];
            if (button == null) continue;
            boolean selected = index == destination;
            button.setTextColor(selected ? MoaColors.INK : MoaColors.MUTED);
            button.setBackground(MoaDrawables.rounded(
                    selected ? MoaColors.GOLD : 0x00000000, dp(13),
                    selected ? MoaColors.GOLD : 0x00000000, 0));
            button.setContentDescription(button.getText() + (selected ? ", selected" : ""));
        }
    }

    private void add(LinearLayout rail, int destination, String label) {
        Button button = new Button(context);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextSize(13);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setMinHeight(dp(44));
        button.setMinWidth(0);
        button.setPadding(dp(4), dp(8), dp(4), dp(8));
        button.setOnClickListener(view -> listener.onDestinationSelected(destination));
        buttons[destination] = button;
        rail.addView(button, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
