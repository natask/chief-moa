package ai.moa.assistant;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.drawable.Drawable;
import android.view.View;

// The floating Moa lion mark on a dark-glass containment plate, matching the
// browser extension's lit-plate launcher. The plate is a neutral dark circle
// with a soft top-left sheen, a grounding shadow, and a 1px light rim, so the
// lion reads on any wallpaper without a whitish silhouette halo. Live state
// lights the plate: listening = amber ring, held voice = stronger gold glow,
// record note = red ring. The lion grows a touch while active.
final class OrbView extends View {
    // The lion mark fills its own square frame, so the animal centers on the box.
    private static final float GLYPH_VIEWPORT = 108f;
    private static final float BIRD_CX = 54f;
    private static final float BIRD_CY = 54f;

    private final Drawable bird;
    private final Paint glowPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint platePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private boolean listening;
    private boolean held;
    private boolean recordingNote;

    OrbView(Context context) {
        super(context);
        bird = context.getDrawable(R.drawable.moa_mark);
    }

    void setListening(boolean listening) {
        this.listening = listening;
        invalidate();
    }

    // Held = manual voice turn engaged. Lights the glow and grows a touch.
    void setHeld(boolean held) {
        this.held = held;
        invalidate();
    }

    // Recording note = record mode capture in flight. Tints the plate glow red
    // so a raw audio-note capture never looks like a live voice turn.
    void setRecordingNote(boolean recordingNote) {
        this.recordingNote = recordingNote;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (bird == null) {
            return;
        }

        float w = getWidth();
        float h = getHeight();
        float cx = w / 2f;
        float cy = h / 2f;
        float box = Math.min(w, h);

        boolean lit = held || listening || recordingNote;
        // The plate holds a fixed footprint; the lion grows a little while active.
        float plateRadius = box * (held || recordingNote ? 0.47f : listening ? 0.465f : 0.45f);
        float lionSize = box * (held || recordingNote ? 0.88f : listening ? 0.86f : 0.82f);

        drawAmbientShadow(canvas, cx, cy + box * 0.03f, plateRadius * 1.16f);
        if (lit) {
            drawStateGlow(canvas, cx, cy, plateRadius);
        }
        drawPlate(canvas, cx, cy, plateRadius);

        setGlyphBounds(bird, cx, cy, lionSize);
        bird.setAlpha(255);
        bird.draw(canvas);
    }

    // A soft dark bloom below the plate grounds it on any background.
    private void drawAmbientShadow(Canvas canvas, float cx, float cy, float radius) {
        glowPaint.setShader(new RadialGradient(
                cx, cy, radius,
                new int[]{0x66000000, 0x3B000000, 0x00000000},
                new float[]{0f, 0.62f, 1f},
                Shader.TileMode.CLAMP));
        canvas.drawCircle(cx, cy, radius, glowPaint);
        glowPaint.setShader(null);
    }

    // Colored ember bloom behind the plate. Amber while listening, stronger gold
    // while held, red while recording a note.
    private void drawStateGlow(Canvas canvas, float cx, float cy, float plateRadius) {
        int rgb = (recordingNote ? MoaColors.RED : held ? MoaColors.GOLD : MoaColors.AMBER) & 0x00FFFFFF;
        int alpha = held || recordingNote ? 0x82 : 0x5A;
        int core = (alpha << 24) | rgb;
        int mid = ((alpha / 2) << 24) | rgb;
        int edge = rgb;
        float radius = plateRadius * 1.55f;
        glowPaint.setShader(new RadialGradient(
                cx, cy, radius,
                new int[]{core, mid, edge},
                new float[]{0.5f, 0.8f, 1f},
                Shader.TileMode.CLAMP));
        canvas.drawCircle(cx, cy, radius, glowPaint);
        glowPaint.setShader(null);
    }

    // Dark-glass containment plate: opaque base, top-left sheen, hairline rim.
    // The rim picks up the live-state color so the mark reads as one lit object.
    private void drawPlate(Canvas canvas, float cx, float cy, float r) {
        platePaint.setShader(null);
        platePaint.setStyle(Paint.Style.FILL);
        platePaint.setColor(0xF0141518);
        canvas.drawCircle(cx, cy, r, platePaint);

        float gx = cx - r * 0.34f;
        float gy = cy - r * 0.4f;
        platePaint.setShader(new RadialGradient(
                gx, gy, r * 1.25f,
                new int[]{0x2EFFFFFF, 0x0AFFFFFF, 0x00FFFFFF},
                new float[]{0f, 0.45f, 1f},
                Shader.TileMode.CLAMP));
        canvas.drawCircle(cx, cy, r, platePaint);
        platePaint.setShader(null);

        float stroke = Math.max(1f, r * 0.03f);
        platePaint.setStyle(Paint.Style.STROKE);
        platePaint.setStrokeWidth(stroke);
        int rim = recordingNote ? 0x99FF453A
                : held ? 0x99FFD76A
                : listening ? 0x99F5A623
                : 0x26FFFFFF;
        platePaint.setColor(rim);
        canvas.drawCircle(cx, cy, r - stroke / 2f, platePaint);
        platePaint.setStyle(Paint.Style.FILL);
    }

    private void setGlyphBounds(Drawable drawable, float cx, float cy, float size) {
        int left = Math.round(cx - BIRD_CX * size / GLYPH_VIEWPORT);
        int top = Math.round(cy - BIRD_CY * size / GLYPH_VIEWPORT);
        drawable.setBounds(left, top, Math.round(left + size), Math.round(top + size));
    }
}
