package ag.companion;

import android.content.Context;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Immersive voice-first home. The orb is the action; chrome stays out of the way. */
final class MoaTalkHomeView {
    private final Context context;

    MoaTalkHomeView(Context context) { this.context = context; }

    View create(Runnable talk, Runnable refresh) {
        LinearLayout stage = new LinearLayout(context);
        stage.setOrientation(LinearLayout.VERTICAL);
        stage.setGravity(Gravity.CENTER_HORIZONTAL);
        stage.setPadding(dp(22), dp(30), dp(22), dp(24));
        stage.setBackground(MoaDrawables.diagonalGradient(
                0xFF211B12, 0xFF161518, 0xFF101014, dp(28), MoaColors.GOLD_BORDER, dp(1)));
        stage.setElevation(dp(10));
        LinearLayout.LayoutParams stageParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        stageParams.topMargin = dp(8);
        stage.setLayoutParams(stageParams);

        TextView signal = text("AG IS READY", MoaColors.GOLD_BRIGHT, 11, true);
        signal.setLetterSpacing(0.2f);
        signal.setBackground(MoaDrawables.rounded(MoaColors.GOLD_WASH, dp(99), MoaColors.GOLD_BORDER, dp(1)));
        signal.setPadding(dp(13), dp(6), dp(13), dp(6));
        stage.addView(signal);

        TextView title = text("Say what’s on your mind.", MoaColors.PAPER, 27, true);
        title.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, dp(18), 0, dp(5));
        stage.addView(title);

        TextView message = text("Ask a question, give feedback, or shape what Ag builds next.",
                MoaColors.MUTED, 15, false);
        message.setGravity(Gravity.CENTER);
        message.setLineSpacing(dp(3), 1f);
        stage.addView(message);

        FrameLayout orb = voiceOrb();
        orb.setContentDescription("Talk to Ag");
        orb.setClickable(true);
        orb.setFocusable(true);
        orb.setOnClickListener(view -> talk.run());
        LinearLayout.LayoutParams orbParams = new LinearLayout.LayoutParams(dp(150), dp(150));
        orbParams.topMargin = dp(22);
        stage.addView(orb, orbParams);

        TextView instruction = text("Tap to speak", MoaColors.PAPER, 16, true);
        instruction.setGravity(Gravity.CENTER);
        instruction.setPadding(0, dp(10), 0, dp(2));
        stage.addView(instruction);
        TextView privacy = text("Private to your account  ·  Interrupt anytime", MoaColors.MUTED, 12, false);
        privacy.setGravity(Gravity.CENTER);
        stage.addView(privacy);

        TextView refreshAction = text("Refresh conversation", MoaColors.GOLD, 13, true);
        refreshAction.setGravity(Gravity.CENTER);
        refreshAction.setMinHeight(dp(48));
        refreshAction.setPadding(dp(14), dp(8), dp(14), dp(8));
        refreshAction.setClickable(true);
        refreshAction.setFocusable(true);
        refreshAction.setContentDescription("Refresh conversation");
        refreshAction.setOnClickListener(view -> refresh.run());
        stage.addView(refreshAction);
        return stage;
    }

    private FrameLayout voiceOrb() {
        FrameLayout outer = new FrameLayout(context);
        outer.setBackground(MoaDrawables.circle(0x14E1BB68, MoaColors.GOLD_BORDER, dp(1)));
        outer.setPadding(dp(14), dp(14), dp(14), dp(14));
        outer.setElevation(dp(14));

        FrameLayout middle = new FrameLayout(context);
        middle.setBackground(MoaDrawables.diagonalGradient(
                0xFFE7C77C, 0xFFB8792F, 0xFF3C2814, dp(99), MoaColors.GOLD_BRIGHT, dp(1)));
        middle.setPadding(dp(13), dp(13), dp(13), dp(13));
        outer.addView(middle, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        ImageView mark = new ImageView(context);
        mark.setImageResource(R.drawable.moa_mark);
        mark.setBackground(MoaDrawables.circle(MoaColors.MARK_BACKING, 0x66FFFFFF, dp(1)));
        mark.setPadding(dp(13), dp(13), dp(13), dp(13));
        middle.addView(mark, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return outer;
    }

    private TextView text(String value, int color, int size, boolean bold) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(size);
        if (bold) view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return view;
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
