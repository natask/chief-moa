package ai.moa.assistant;

import android.animation.ArgbEvaluator;
import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.view.View;
import android.view.animation.LinearInterpolator;

import java.util.Locale;

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
// rim between the pet hairline and accent (~1.4s cycle, no scale change),
// RESPONDING holds a steady pet-accent tint on the mark, and ERROR holds a
// steady ember rim for the short error window. The pulse animator only runs
// while THINKING, so the idle orb never burns battery.
//
// LISTENING is separate: while the mic is open it holds a steady, slightly
// thicker violet rim (no pulse), distinct from the THINKING pulse and the
// RESPONDING gold, so "the orb is hearing me" reads at a glance. This matters
// most for the voice-first toggle-talk loop, whose on/off states must be
// obvious.
final class OrbView extends View {
    // The lion mark fills its own square frame, so the animal centers on the box.
    private static final float GLYPH_VIEWPORT = 108f;
    private static final float MARK_CX = 54f;
    private static final float MARK_CY = 54f;
    private static final int RECORDING_TINT = 0x8CFF4D4D;
    // Steady rim while the mic is listening. A bright violet, matching the "You"
    // transcript label, so an open mic reads as the user's turn and stays clear
    // of the gold response cue.
    private static final int LISTENING_RIM = 0xFF9C8BFF;
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
    private final Paint petMotionPaint;
    private final RectF petMotionArc = new RectF();
    private final float rimWidthPx;
    // A touch thicker so the steady listening rim reads clearly against the disc.
    private final float listeningRimWidthPx;
    private final ArgbEvaluator argb = new ArgbEvaluator();
    private boolean listening;
    private boolean held;
    private boolean recordingNote;
    private ResponseState responseState = ResponseState.NONE;
    private ValueAnimator thinkingPulse;
    private float thinkingPulseFraction;
    private int petBackingColor = MoaColors.MARK_BACKING;
    private int petAccentColor = MoaColors.GOLD;
    private int petRimColor = MoaColors.RAISED_BORDER;
    private String petMotion = "idle";

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
        listeningRimWidthPx = Math.max(2f, context.getResources().getDisplayMetrics().density * 2f);
        rimPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        rimPaint.setStyle(Paint.Style.STROKE);
        rimPaint.setStrokeWidth(rimWidthPx);
        rimPaint.setColor(MoaColors.RAISED_BORDER);
        petMotionPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        petMotionPaint.setStyle(Paint.Style.STROKE);
        petMotionPaint.setStrokeCap(Paint.Cap.ROUND);
    }

    void setPetVisualState(MoaPrefs.PetVisualState visual) {
        if (visual == null) {
            setPetPalette(MoaColors.MARK_BACKING, MoaColors.GOLD, MoaColors.RAISED_BORDER);
            setPetMotion("idle");
            return;
        }
        setPetPalette(visual.backingColor, visual.accentColor, visual.rimColor);
        setPetMotion(visual.motion);
    }

    void setPetPalette(int backingColor, int accentColor, int rimColor) {
        if (petBackingColor == backingColor && petAccentColor == accentColor && petRimColor == rimColor) {
            return;
        }
        petBackingColor = backingColor;
        petAccentColor = accentColor;
        petRimColor = rimColor;
        invalidate();
    }

    void setPetMotion(String motion) {
        String next = motion == null || motion.trim().isEmpty() ? "idle" : motion.trim().toLowerCase(Locale.US);
        if (next.equals(petMotion)) {
            return;
        }
        petMotion = next;
        invalidate();
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
        backingPaint.setColor(petBackingColor);
        canvas.drawCircle(cx, cy, discRadius, backingPaint);
        // The steady listening rim is a touch thicker; every other state keeps
        // the hairline. Inset by half the active stroke so it stays inside.
        float rimStroke = listeningRimActive() ? listeningRimWidthPx : rimWidthPx;
        rimPaint.setStrokeWidth(rimStroke);
        rimPaint.setColor(currentRimColor());
        canvas.drawCircle(cx, cy, discRadius - rimStroke / 2f, rimPaint);
        drawPetMotionTreatment(canvas, cx, cy, discRadius, rimStroke);

        if (recordingNote) {
            mark.setColorFilter(RECORDING_TINT, PorterDuff.Mode.SRC_ATOP);
        } else if (responseState == ResponseState.RESPONDING) {
            mark.setColorFilter(colorWithAlpha(petAccentColor, 0xCC), PorterDuff.Mode.SRC_ATOP);
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
            return (int) argb.evaluate(thinkingPulseFraction, petRimColor, petAccentColor);
        }
        if (responseState == ResponseState.ERROR) {
            return MoaColors.EMBER;
        }
        if (listeningRimActive()) {
            return LISTENING_RIM;
        }
        return petRimColor;
    }

    private void drawPetMotionTreatment(Canvas canvas, float cx, float cy, float discRadius, float rimStroke) {
        if (responseState == ResponseState.ERROR || recordingNote) {
            return;
        }
        float inset = Math.max(rimStroke * 3f, rimWidthPx * 4f);
        float radius = Math.max(0f, discRadius - inset);
        if (radius <= 0f) {
            return;
        }
        petMotionPaint.setStrokeWidth(Math.max(rimWidthPx, rimStroke));
        petMotionPaint.setColor(colorWithAlpha(petAccentColor, listening ? 0x66 : 0x42));
        petMotionPaint.setStyle(Paint.Style.STROKE);
        petMotionArc.set(cx - radius, cy - radius, cx + radius, cy + radius);
        switch (petMotion) {
            case "float":
            case "trail":
            case "hover":
                canvas.drawCircle(cx, cy, radius, petMotionPaint);
                break;
            case "peek":
            case "climb":
                canvas.drawArc(petMotionArc, 205f, 95f, false, petMotionPaint);
                break;
            case "tap":
            case "spark":
                petMotionPaint.setStyle(Paint.Style.FILL);
                canvas.drawCircle(cx + radius * 0.45f, cy - radius * 0.45f, Math.max(2f, rimWidthPx * 2.2f), petMotionPaint);
                break;
            case "walk":
                canvas.drawArc(petMotionArc, 50f, 80f, false, petMotionPaint);
                break;
            default:
                break;
        }
    }

    private int colorWithAlpha(int color, int alpha) {
        return ((alpha & 0xFF) << 24) | (color & 0x00FFFFFF);
    }

    // The listening rim shows whenever the mic is open, unless a THINKING pulse
    // or an ERROR rim already owns the disc edge.
    private boolean listeningRimActive() {
        return listening
                && responseState != ResponseState.THINKING
                && responseState != ResponseState.ERROR;
    }

    private void setGlyphBounds(Drawable drawable, float cx, float cy, float size) {
        int left = Math.round(cx - MARK_CX * size / GLYPH_VIEWPORT);
        int top = Math.round(cy - MARK_CY * size / GLYPH_VIEWPORT);
        drawable.setBounds(left, top, Math.round(left + size), Math.round(top + size));
    }
}
