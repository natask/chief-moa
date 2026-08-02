package ag.companion;

import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Full-app presentation selector, kept out of the already-large activity. */
final class MoaPresentationSettingsView {
    private MoaPresentationSettingsView() {}

    static LinearLayout create(Context context) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(context, 18), dp(context, 18), dp(context, 18), dp(context, 18));
        card.setBackground(MoaDrawables.rounded(
                MoaColors.RAISED, dp(context, 20), MoaColors.RAISED_BORDER, dp(context, 1)));
        card.setElevation(dp(context, 6));
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cardParams.topMargin = dp(context, 14);
        card.setLayoutParams(cardParams);

        TextView title = MoaTextViews.text(context, "Voice presentation", MoaColors.PAPER, 18, true);
        title.setPadding(0, 0, 0, dp(context, 12));
        card.addView(title);
        TextView detail = MoaTextViews.text(context,
                "Companion shows the mascot and messages. Minimal shows four subtle, touch-through edge lights and one small Ag button for the full app.",
                MoaColors.MUTED, 13, false);
        detail.setPadding(0, 0, 0, dp(context, 10));
        card.addView(detail);

        LinearLayout choices = new LinearLayout(context);
        Button companion = button(context, "Companion");
        Button minimal = button(context, "Minimal");
        choices.addView(companion, weighted());
        LinearLayout.LayoutParams right = weighted();
        right.leftMargin = dp(context, 8);
        choices.addView(minimal, right);
        card.addView(choices);

        TextView selected = MoaTextViews.text(context, "", MoaColors.GOLD, 14, true);
        selected.setPadding(0, dp(context, 10), 0, 0);
        card.addView(selected);
        Runnable refresh = () -> selected.setText(
                MoaPrefs.presentationStyle(context) == MoaPresentationStyle.MINIMAL
                        ? "Minimal selected" : "Companion selected");
        companion.setOnClickListener(view -> select(context, MoaPresentationStyle.COMPANION, refresh));
        minimal.setOnClickListener(view -> select(context, MoaPresentationStyle.MINIMAL, refresh));
        refresh.run();
        return card;
    }

    private static void select(Context context, MoaPresentationStyle style, Runnable refresh) {
        MoaPrefs.setPresentationStyle(context, style);
        refresh.run();
        try {
            context.startService(new Intent(context, OverlayService.class)
                    .setAction(OverlayService.ACTION_REFRESH_PRESENTATION));
        } catch (Exception ignored) {}
    }

    private static Button button(Context context, String text) {
        Button button = new Button(context);
        button.setAllCaps(false);
        button.setText(text);
        button.setTextColor(MoaColors.PAPER);
        button.setTextSize(16);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setBackground(MoaDrawables.rounded(
                0x14FFFFFF, dp(context, 16), MoaColors.RAISED_BORDER, dp(context, 1)));
        button.setMinHeight(dp(context, 52));
        return button;
    }

    private static LinearLayout.LayoutParams weighted() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
