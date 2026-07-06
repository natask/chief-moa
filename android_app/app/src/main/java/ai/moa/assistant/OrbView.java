package ai.moa.assistant;

import android.animation.ArgbEvaluator;
import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.drawable.Drawable;
import android.view.View;
import android.view.animation.LinearInterpolator;

// The floating Moa lion mark sits on a solid warm near-black disc, mirroring the
// adaptive launcher icon (mark over ic_launcher_background). The opaque disc is
// what lets the lion's dark eyes read over light content underneath; the window
// itself stays translucent so the orb reads as a round coin, not a square.
// State reads from the panel text, not from light (parity with the browser
// extension). Listening and held turns grow the mark a touch. Recording a raw
// audio note tints the mark red — steady, no pulse — so a capture never looks
// like a live voice turn.
//
// The agent's response is visible on the orb itself: THINKING pulses the disc
// rim between the hairline and gold (~1.4s cycle, no scale change), RESPONDING
// holds a steady gold tint on the mark, and ERROR holds a steady ember rim for
// the short error window. The pulse animator only runs while THINKING, so the
// idle orb never burns battery.
final class OrbView extends View {
    // The lion mark fills its own square frame, so the animal centers on the box.
    private static final float GLYPH_VIEWPORT = 108f;
    private static final float MARK_CX = 54f;
    private static final float MARK_CY = 54f;
    private static final int RECORDING_TINT = 0x8CFF4D4D;
    // Steady gold laid over the mark while the agent is responding, via the same
    // SRC_ATOP tint the recording state uses. Softened alpha so the lion's form
    // still reads through the wash.
    private static final int RESPONDING_TINT = 0xCCFFD76A;
    private static final long THINKING_PULSE_MS = 1400;

    // What the agent is doing, surfaced on the orb. Driven only from the single
    // setVoiceRuntimeState choke point in the overlay service.
    enum ResponseState {
        NONE,
        THINKING,
        RESPONDING,
        ERROR
    }

    private final Drawable mark;
    private final Paint backingPaint;
    private final Paint rimPaint;
    private final float rimWidthPx;
    private final ArgbEvaluator argb = new ArgbEvaluator();
    private boolean listening;
    private boolean held;
    private boolean recordingNote;
    private ResponseState responseState = ResponseState.NONE;
    private ValueAnimator thinkingPulse;
    private float thinkingPulseFraction;

    OrbView(Context context) {
        super(context);
        mark = context.getDrawable(R.drawable.moa_mark);
        if (mark != null) {
            mark.mutate();
        }
        // Opaque disc behind the mark. Anti-aliased so the circle edge is clean.
        backingPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        backingPaint.setStyle(Paint.Style.FILL);
        backingPaint.setColor(MoaColors.MARK_BACKING);
        // A minimal hairline rim so the disc reads as a deliberate coin, not a
        // flat cutout. One physical pixel, the same faint white as card borders.
        rimWidthPx = Math.max(1f, context.getResources().getDisplayMetrics().density);
        rimPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        rimPaint.setStyle(Paint.Style.STROKE);
        rimPaint.setStrokeWidth(rimWidthPx);
        rimPaint.setColor(MoaColors.RAISED_BORDER);
    }

    void setListening(boolean listening) {
        this.listening = listening;
        invalidate();
    }

    // Held = manual voice turn engaged. Grows the mark a touch.
    void setHeld(boolean held) {
        this.held = held;
        invalidate();
    }

    // Recording note = record mode capture in flight. Steady red tint on the
    // mark keeps the recording state visually distinct without any glow.
    void setRecordingNote(boolean recordingNote) {
        this.recordingNote = recordingNote;
        invalidate();
    }

    // Reflect what the agent is doing. THINKING starts the rim pulse; every other
    // state stops it so the orb costs nothing at idle. A no-op if unchanged.
    void setResponseState(ResponseState state) {
        ResponseState next = state == null ? ResponseState.NONE : state;
        if (next == responseState) {
            return;
        }
        responseState = next;
        if (responseState == ResponseState.THINKING) {
            startThinkingPulse();
        } else {
            stopThinkingPulse();
        }
        invalidate();
    }

    private void startThinkingPulse() {
        if (thinkingPulse != null) {
            return;
        }
        ValueAnimator animator = ValueAnimator.ofFloat(0f, 1f);
        animator.setDuration(THINKING_PULSE_MS / 2);
        animator.setRepeatMode(ValueAnimator.REVERSE);
        animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.setInterpolator(new LinearInterpolator());
        animator.addUpdateListener(animation -> {
            thinkingPulseFraction = (float) animation.getAnimatedValue();
            invalidate();
        });
        thinkingPulse = animator;
        animator.start();
    }

    private void stopThinkingPulse() {
        if (thinkingPulse != null) {
            thinkingPulse.cancel();
            thinkingPulse = null;
        }
        thinkingPulseFraction = 0f;
    }

    @Override
    protected void onDetachedFromWindow() {
        // Never leave the pulse animator running past the view's life.
        stopThinkingPulse();
        super.onDetachedFromWindow();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (mark == null) {
            return;
        }

        float w = getWidth();
        float h = getHeight();
        float cx = w / 2f;
        float cy = h / 2f;
        float size = Math.min(w, h) * (held || recordingNote ? 1.0f : (listening ? 0.98f : 0.92f));

        // Solid disc first, then the mark on top. The disc fills the round orb
        // window so the lion always sits on an opaque field regardless of the
        // state-driven mark scale. Inset the rim by half its width so the
        // stroke stays inside the view and is not clipped at the edge.
        float discRadius = Math.min(w, h) / 2f;
        canvas.drawCircle(cx, cy, discRadius, backingPaint);
        rimPaint.setColor(currentRimColor());
        canvas.drawCircle(cx, cy, discRadius - rimWidthPx / 2f, rimPaint);

        if (recordingNote) {
            mark.setColorFilter(RECORDING_TINT, PorterDuff.Mode.SRC_ATOP);
        } else if (responseState == ResponseState.RESPONDING) {
            mark.setColorFilter(RESPONDING_TINT, PorterDuff.Mode.SRC_ATOP);
        } else {
            mark.clearColorFilter();
        }
        setGlyphBounds(mark, cx, cy, size);
        mark.setAlpha(255);
        mark.draw(canvas);
    }

    // Rim color by state. THINKING pulses the hairline toward gold and back;
    // ERROR holds ember for the short error window; everything else is the
    // default faint hairline. Recording keeps the default rim (its cue is the
    // red mark tint), so a capture never reads like a live response.
    private int currentRimColor() {
        if (responseState == ResponseState.THINKING) {
            return (int) argb.evaluate(thinkingPulseFraction, MoaColors.RAISED_BORDER, MoaColors.GOLD);
        }
        if (responseState == ResponseState.ERROR) {
            return MoaColors.EMBER;
        }
        return MoaColors.RAISED_BORDER;
    }

    private void setGlyphBounds(Drawable drawable, float cx, float cy, float size) {
        int left = Math.round(cx - MARK_CX * size / GLYPH_VIEWPORT);
        int top = Math.round(cy - MARK_CY * size / GLYPH_VIEWPORT);
        drawable.setBounds(left, top, Math.round(left + size), Math.round(top + size));
    }
}
