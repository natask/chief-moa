package ai.moa.assistant;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.drawable.Drawable;
import android.view.View;

// The floating Moa lion mark: just the animal, no disc. The dark silhouette would
// vanish on dark app backgrounds, so a soft light halo (the mark feathered
// behind itself) gives it contrast on any screen. Listening tints the halo gold
// and grows the mark a touch instead of lighting up an orb. A double-tap that
// starts a voice turn lights a soft gold glow behind it so the live state reads.
final class OrbView extends View {
    // The lion mark fills its own square frame, so the animal centers on the box.
    private static final float GLYPH_VIEWPORT = 108f;
    private static final float BIRD_CX = 54f;
    private static final float BIRD_CY = 54f;

    private final Drawable bird;
    private final Drawable halo;
    private final Paint glowPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private boolean listening;
    private boolean held;

    OrbView(Context context) {
        super(context);
        bird = context.getDrawable(R.drawable.moa_mark);
        halo = context.getDrawable(R.drawable.moa_mark);
        if (halo != null) {
            halo.mutate();
        }
    }

    void setListening(boolean listening) {
        this.listening = listening;
        invalidate();
    }

    // Held = live voice turn engaged (double-tap). Lights the glow and grows a touch.
    void setHeld(boolean held) {
        this.held = held;
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

        boolean lit = held || listening;
        // Bird fills most of the window now that the disc is gone. It grows a
        // little while listening, and a touch more while held.
        float size = Math.min(w, h) * (held ? 1.0f : (listening ? 0.98f : 0.92f));

        if (lit) {
            drawGlow(canvas, cx, cy, Math.min(w, h));
        }
        drawHalo(canvas, cx, cy, size);

        setGlyphBounds(bird, cx, cy, size);
        bird.setAlpha(255);
        bird.draw(canvas);
    }

    // Soft gold radial bloom behind the mark. Stronger while held, softer while
    // listening, so a live voice turn gets an unmistakable lit state without a disc.
    private void drawGlow(Canvas canvas, float cx, float cy, float box) {
        float radius = box * 0.62f;
        int core = held ? 0x66F4D35E : 0x55F4D35E;
        int edge = 0x00F4D35E;
        glowPaint.setShader(new RadialGradient(cx, cy, radius, core, edge, Shader.TileMode.CLAMP));
        canvas.drawCircle(cx, cy, radius, glowPaint);
        glowPaint.setShader(null);
    }

    // Feathered light rim: the same silhouette drawn a few times, larger and
    // fainter, tinted light (gold while listening). Reads on dark backgrounds
    // without bringing back a circle.
    private void drawHalo(Canvas canvas, float cx, float cy, float size) {
        if (halo == null) {
            return;
        }
        int tint = listening ? MoaColors.GOLD : 0xFFF7FFF1;
        halo.setColorFilter(tint, PorterDuff.Mode.SRC_IN);

        float[] scales = {1.18f, 1.10f, 1.05f};
        int[] alphas = listening ? new int[]{70, 120, 200} : new int[]{45, 80, 150};
        for (int i = 0; i < scales.length; i++) {
            setGlyphBounds(halo, cx, cy, size * scales[i]);
            halo.setAlpha(alphas[i]);
            halo.draw(canvas);
        }
        halo.clearColorFilter();
    }

    private void setGlyphBounds(Drawable drawable, float cx, float cy, float size) {
        int left = Math.round(cx - BIRD_CX * size / GLYPH_VIEWPORT);
        int top = Math.round(cy - BIRD_CY * size / GLYPH_VIEWPORT);
        drawable.setBounds(left, top, Math.round(left + size), Math.round(top + size));
    }
}
