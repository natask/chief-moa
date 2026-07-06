package ai.moa.assistant;

import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;

final class MoaDrawables {
    private MoaDrawables() {
    }

    // A circular button that darkens on press. Used for the gold send button so
    // a tap reads as a real press instead of a flat glyph.
    static StateListDrawable circlePressable(int normal, int pressed, int strokeColor, int strokeWidth) {
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[]{android.R.attr.state_pressed}, circle(pressed, strokeColor, strokeWidth));
        states.addState(new int[]{}, circle(normal, strokeColor, strokeWidth));
        return states;
    }

    static GradientDrawable rounded(int color, int radius, int strokeColor, int strokeWidth) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radius);
        if (strokeWidth > 0) {
            drawable.setStroke(strokeWidth, strokeColor);
        }
        return drawable;
    }

    static GradientDrawable verticalGradient(int top, int bottom) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{top, bottom});
        drawable.setCornerRadius(0);
        return drawable;
    }

    static GradientDrawable horizontalGradient(int left, int right, int radius) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, new int[]{left, right});
        drawable.setCornerRadius(radius);
        return drawable;
    }

    // Rounded vertical gradient with a hairline border. Used for the panel card
    // and for raised bubbles so they read with a little depth.
    static GradientDrawable roundedGradient(int top, int bottom, int radius, int strokeColor, int strokeWidth) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{top, bottom});
        drawable.setCornerRadius(radius);
        if (strokeWidth > 0) {
            drawable.setStroke(strokeWidth, strokeColor);
        }
        return drawable;
    }

    // Per-corner rounded fill. Lets a chat bubble round three corners hard and
    // tuck the corner nearest its owner so it reads as "from" that side.
    static GradientDrawable roundedCorners(int color, float[] radii, int strokeColor, int strokeWidth) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadii(radii);
        if (strokeWidth > 0) {
            drawable.setStroke(strokeWidth, strokeColor);
        }
        return drawable;
    }

    static GradientDrawable circle(int color, int strokeColor, int strokeWidth) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.OVAL);
        drawable.setColor(color);
        if (strokeWidth > 0) {
            drawable.setStroke(strokeWidth, strokeColor);
        }
        return drawable;
    }
}
