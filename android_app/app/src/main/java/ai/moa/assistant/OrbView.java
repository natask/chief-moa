package ai.moa.assistant;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.drawable.Drawable;
import android.view.View;

// The floating Moa lion mark sits on a solid warm near-black disc, mirroring the
// adaptive launcher icon (mark over ic_launcher_background). The opaque disc is
// what lets the lion's dark eyes read over light content underneath; the window
// itself stays translucent so the orb reads as a round coin, not a square.
// State reads from the panel text, not from light (parity with the browser
// extension). Listening and held turns grow the mark a touch. Recording a raw
// audio note tints the mark red — steady, no pulse — so a capture never looks
// like a live voice turn.
final class OrbView extends View {
    // The lion mark fills its own square frame, so the animal centers on the box.
    private static final float GLYPH_VIEWPORT = 108f;
    private static final float MARK_CX = 54f;
    private static final float MARK_CY = 54f;
    private static final int RECORDING_TINT = 0x8CFF4D4D;

    private final Drawable mark;
    private final Paint backingPaint;
    private final Paint rimPaint;
    private final float rimWidthPx;
    private boolean listening;
    private boolean held;
    private boolean recordingNote;

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
        canvas.drawCircle(cx, cy, discRadius - rimWidthPx / 2f, rimPaint);

        if (recordingNote) {
            mark.setColorFilter(RECORDING_TINT, PorterDuff.Mode.SRC_ATOP);
        } else {
            mark.clearColorFilter();
        }
        setGlyphBounds(mark, cx, cy, size);
        mark.setAlpha(255);
        mark.draw(canvas);
    }

    private void setGlyphBounds(Drawable drawable, float cx, float cy, float size) {
        int left = Math.round(cx - MARK_CX * size / GLYPH_VIEWPORT);
        int top = Math.round(cy - MARK_CY * size / GLYPH_VIEWPORT);
        drawable.setBounds(left, top, Math.round(left + size), Math.round(top + size));
    }
}
