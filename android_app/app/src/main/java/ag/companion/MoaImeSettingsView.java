package ag.companion;

import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Full-app entry into Android's user-owned input-method settings. */
final class MoaImeSettingsView {
    private MoaImeSettingsView() {
    }

    static View create(Context context) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(context, 18), dp(context, 16), dp(context, 18), dp(context, 16));
        card.setBackgroundColor(MoaColors.RAISED);
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cardParams.setMargins(0, dp(context, 10), 0, 0);
        card.setLayoutParams(cardParams);

        TextView title = new TextView(context);
        title.setText("Voice keyboard");
        title.setTextColor(MoaColors.PAPER);
        title.setTextSize(17f);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        card.addView(title);

        TextView detail = new TextView(context);
        detail.setText("Enable Ag voice typing to dictate into ordinary fields. Password fields stay blocked.");
        detail.setTextColor(MoaColors.MUTED);
        detail.setTextSize(14f);
        detail.setPadding(0, dp(context, 6), 0, dp(context, 8));
        card.addView(detail);

        Button settings = new Button(context);
        settings.setAllCaps(false);
        settings.setText("Open keyboard settings");
        settings.setOnClickListener(view -> context.startActivity(
                new Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)));
        card.addView(settings);
        return card;
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
