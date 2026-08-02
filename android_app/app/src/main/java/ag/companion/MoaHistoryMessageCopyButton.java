package ag.companion;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Typeface;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;

/** One exact local clipboard action for one retained History message. */
final class MoaHistoryMessageCopyButton {
    private MoaHistoryMessageCopyButton() {}

    static Button create(Context context, String speaker, String content) {
        String role = "YOU".equals(speaker) ? "user" : "assistant";
        Button copy = new Button(context);
        copy.setAllCaps(false);
        copy.setText("Copy");
        copy.setTextColor(MoaColors.PAPER);
        copy.setTextSize(13);
        copy.setTypeface(Typeface.DEFAULT_BOLD);
        copy.setBackground(MoaDrawables.rounded(
                0x14FFFFFF, dp(context, 12), MoaColors.RAISED_BORDER, dp(context, 1)));
        copy.setPadding(dp(context, 12), dp(context, 8), dp(context, 12), dp(context, 8));
        copy.setMinHeight(dp(context, 48));
        copy.setContentDescription("Copy " + role + " message");
        copy.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        copy.setOnClickListener(view -> copy(context, role, content, copy));
        return copy;
    }

    private static void copy(Context context, String role, String content, Button button) {
        String exact = MoaHistoryCopyText.exact(content);
        ClipboardManager clipboard =
                (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null || exact.isEmpty()) return;
        clipboard.setPrimaryClip(ClipData.newPlainText("AG history " + role + " message", exact));
        button.setText("Copied");
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
