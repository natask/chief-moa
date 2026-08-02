package ag.companion;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;
import android.view.animation.LinearInterpolator;

/** One content-free visual edge. Its WindowManager window is never touchable. */
final class MoaMinimalEdgeView extends View {
    private final Paint base = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint highlight = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF bounds = new RectF();
    private MoaMinimalRingVisualState visual = MoaMinimalRingVisualState.resolve(
            VoiceRuntimeState.READY, false, false, false);
    private float level;
    private float motionPhase;
    private ValueAnimator animator;

    MoaMinimalEdgeView(Context context) {
        super(context);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        base.setStyle(Paint.Style.FILL);
        highlight.setStyle(Paint.Style.STROKE);
        highlight.setStrokeWidth(Math.max(1f, getResources().getDisplayMetrics().density * 0.7f));
    }

    void render(MoaMinimalRingVisualState state, float inputLevel) {
        visual = state;
        level = inputLevel;
        if (state.animate) startMotion(); else stopMotion();
        invalidate();
    }

    private void startMotion() {
        if (animator != null) return;
        animator = ValueAnimator.ofFloat(0f, (float) (Math.PI * 2));
        animator.setDuration(1800L);
        animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.setInterpolator(new LinearInterpolator());
        animator.addUpdateListener(value -> {
            motionPhase = (float) value.getAnimatedValue();
            invalidate();
        });
        animator.start();
    }

    private void stopMotion() {
        if (animator != null) {
            animator.cancel();
            animator = null;
        }
        motionPhase = 0f;
    }

    @Override
    protected void onDetachedFromWindow() {
        stopMotion();
        super.onDetachedFromWindow();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float intensity = visual.intensity(level, motionPhase);
        int alpha = Math.round(255f * visual.alpha * (0.58f + 0.42f * intensity));
        base.setColor(withAlpha(visual.color, alpha));
        float radius = Math.min(getWidth(), getHeight()) / 2f;
        bounds.set(0f, 0f, getWidth(), getHeight());
        canvas.drawRoundRect(bounds, radius, radius, base);

        highlight.setColor(withAlpha(0xFFFFFFFF, Math.round(28f + 48f * intensity)));
        float inset = highlight.getStrokeWidth() / 2f;
        bounds.inset(inset, inset);
        canvas.drawRoundRect(bounds, Math.max(0f, radius - inset),
                Math.max(0f, radius - inset), highlight);
    }

    private static int withAlpha(int color, int alpha) {
        return (color & 0x00FFFFFF) | (Math.max(0, Math.min(255, alpha)) << 24);
    }
}
