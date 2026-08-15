package ag.companion;

import android.content.Context;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Editorial section headers and progressively disclosed settings groups. */
final class MoaSectionHeaderView {
    private MoaSectionHeaderView() { }

    static View create(Context context, String eyebrow, String title, String description) {
        LinearLayout intro = new LinearLayout(context);
        intro.setOrientation(LinearLayout.VERTICAL);
        TextView signal = text(context, eyebrow, MoaColors.GOLD, 10, true);
        signal.setLetterSpacing(0.17f);
        signal.setPadding(0, dp(context, 7), 0, dp(context, 9));
        intro.addView(signal);
        TextView heading = text(context, title, MoaColors.PAPER, 28, true);
        heading.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        intro.addView(heading);
        TextView detail = text(context, description, MoaColors.MUTED, 14, false);
        detail.setLineSpacing(dp(context, 3), 1f);
        detail.setPadding(0, dp(context, 6), 0, dp(context, 8));
        intro.addView(detail);
        return intro;
    }

    static View create(Context context, String title, String description) {
        return create(context, "AG · " + title.toUpperCase(), title, description);
    }

    static LinearLayout stack(Context context, View... views) {
        LinearLayout stack = new LinearLayout(context);
        stack.setOrientation(LinearLayout.VERTICAL);
        for (View view : views) stack.addView(view);
        return stack;
    }

    static View disclosure(Context context, String icon, String title, String description,
            View content, boolean initiallyExpanded) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(MoaDrawables.roundedGradient(
                MoaColors.RAISED_2, MoaColors.RAISED, dp(context, 20),
                MoaColors.RAISED_BORDER, dp(context, 1)));
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cardParams.topMargin = dp(context, 12);
        card.setLayoutParams(cardParams);

        LinearLayout summary = new LinearLayout(context);
        summary.setGravity(Gravity.CENTER_VERTICAL);
        summary.setPadding(dp(context, 16), dp(context, 15), dp(context, 13), dp(context, 15));
        summary.setClickable(true);
        summary.setFocusable(true);
        summary.setContentDescription(title + (initiallyExpanded ? ", expanded" : ", collapsed"));

        TextView glyph = text(context, icon, MoaColors.GOLD, 18, true);
        glyph.setGravity(Gravity.CENTER);
        glyph.setBackground(MoaDrawables.circle(MoaColors.GOLD_WASH, MoaColors.GOLD_BORDER, dp(context, 1)));
        summary.addView(glyph, new LinearLayout.LayoutParams(dp(context, 38), dp(context, 38)));

        LinearLayout copy = new LinearLayout(context);
        copy.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams copyParams = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        copyParams.leftMargin = dp(context, 12);
        copy.addView(text(context, title, MoaColors.PAPER, 15, true));
        TextView note = text(context, description, MoaColors.MUTED, 12, false);
        note.setMaxLines(2);
        note.setPadding(0, dp(context, 2), 0, 0);
        copy.addView(note);
        summary.addView(copy, copyParams);

        TextView chevron = text(context, initiallyExpanded ? "−" : "+", MoaColors.GOLD, 22, false);
        chevron.setGravity(Gravity.CENTER);
        summary.addView(chevron, new LinearLayout.LayoutParams(dp(context, 34), dp(context, 38)));
        card.addView(summary);

        LinearLayout body = new LinearLayout(context);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(context, 12), 0, dp(context, 12), dp(context, 12));
        body.addView(content);
        body.setVisibility(initiallyExpanded ? View.VISIBLE : View.GONE);
        card.addView(body);
        summary.setOnClickListener(view -> {
            boolean expand = body.getVisibility() != View.VISIBLE;
            body.setVisibility(expand ? View.VISIBLE : View.GONE);
            chevron.setText(expand ? "−" : "+");
            summary.setContentDescription(title + (expand ? ", expanded" : ", collapsed"));
            summary.setSelected(expand);
        });
        summary.setSelected(initiallyExpanded);
        return card;
    }

    private static TextView text(Context context, String value, int color, int size, boolean bold) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(size);
        if (bold) view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return view;
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
