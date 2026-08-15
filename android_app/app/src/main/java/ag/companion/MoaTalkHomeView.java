package ag.companion;

import android.content.Context;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/** The product home: one obvious way to start talking, without setup clutter. */
final class MoaTalkHomeView {
    private final Context context;

    MoaTalkHomeView(Context context) { this.context = context; }

    View create(Runnable talk, Runnable refresh) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        card.setPadding(dp(22), dp(26), dp(22), dp(22));
        card.setBackground(MoaDrawables.roundedGradient(
                0xFF211D18, MoaColors.RAISED, dp(24), MoaColors.PANEL_BORDER, dp(1)));
        card.setElevation(dp(8));
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cardParams.topMargin = dp(18);
        card.setLayoutParams(cardParams);

        ImageView mark = new ImageView(context);
        mark.setImageResource(R.drawable.moa_mark);
        mark.setBackground(MoaDrawables.circle(MoaColors.MARK_BACKING, MoaColors.GOLD, dp(1)));
        mark.setPadding(dp(9), dp(9), dp(9), dp(9));
        card.addView(mark, new LinearLayout.LayoutParams(dp(72), dp(72)));

        TextView title = text("What do you need?", MoaColors.PAPER, 25, true);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, dp(16), 0, dp(6));
        card.addView(title);
        TextView message = text("Speak naturally. Ag keeps the conversation and can turn your feedback into work.",
                MoaColors.MUTED, 15, false);
        message.setGravity(Gravity.CENTER);
        message.setLineSpacing(dp(3), 1f);
        card.addView(message);

        Button talkButton = button("Talk to Ag", true);
        talkButton.setContentDescription("Open Ag and start talking");
        talkButton.setOnClickListener(view -> talk.run());
        card.addView(talkButton);

        Button refreshButton = button("Refresh conversation", false);
        refreshButton.setOnClickListener(view -> refresh.run());
        card.addView(refreshButton);
        return card;
    }

    private Button button(String label, boolean primary) {
        Button button = new Button(context);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextSize(16);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setTextColor(primary ? MoaColors.INK : MoaColors.PAPER);
        button.setBackground(primary
                ? MoaDrawables.horizontalGradient(MoaColors.GOLD, 0xFFFFF1A6, dp(16))
                : MoaDrawables.rounded(0x14FFFFFF, dp(16), MoaColors.RAISED_BORDER, dp(1)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(12);
        button.setLayoutParams(params);
        button.setMinHeight(dp(52));
        return button;
    }

    private TextView text(String value, int color, int size, boolean bold) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(size);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
