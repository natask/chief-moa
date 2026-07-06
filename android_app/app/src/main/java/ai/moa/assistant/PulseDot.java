package ai.moa.assistant;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.View;

// A small status dot. Ready = a calm solid gold pip. Busy = an amber core with
// a breathing halo, so a run in flight reads without a spinner. The animator
// runs only while busy so a ready dot costs nothing.
final class PulseDot extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private ValueAnimator animator;
    private float pulse;
    private boolean busy;

    PulseDot(Context context) {
        super(context);
    }

    void setBusy(boolean busy) {
        if (this.busy == busy) {
            return;
        }
        this.busy = busy;
        syncAnimator();
        invalidate();
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        syncAnimator();
    }

    private void syncAnimator() {
        if (busy) {
            if (animator == null) {
                animator = ValueAnimator.ofFloat(0f, 1f);
                animator.setDuration(1100);
                animator.setRepeatCount(ValueAnimator.INFINITE);
                animator.setRepeatMode(ValueAnimator.REVERSE);
                animator.addUpdateListener(animation -> {
                    pulse = (float) animation.getAnimatedValue();
                    invalidate();
                });
            }
            if (isAttachedToWindow() && !animator.isStarted()) {
                animator.start();
            }
        } else if (animator != null) {
            animator.cancel();
            pulse = 0f;
        }
    }

    @Override
    protected void onDetachedFromWindow() {
        if (animator != null) {
            animator.cancel();
        }
        super.onDetachedFromWindow();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float cx = getWidth() / 2f;
        float cy = getHeight() / 2f;
        float radius = Math.min(getWidth(), getHeight()) * 0.3f;
        if (busy) {
            paint.setColor(0x40F5A623);
            canvas.drawCircle(cx, cy, radius * (1.45f + pulse * 0.4f), paint);
            paint.setColor(MoaColors.AMBER);
        } else {
            paint.setColor(MoaColors.GOLD);
        }
        canvas.drawCircle(cx, cy, radius, paint);
    }
}
