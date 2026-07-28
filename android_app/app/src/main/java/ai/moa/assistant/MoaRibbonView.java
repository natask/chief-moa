package ai.moa.assistant;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * One ribbon: a fixed streaming line inside a compact translucent bubble.
 *
 * This is the whole anti-occlusion fix. The old voice card was a filled,
 * bordered, scrolling rectangle that grew with the conversation and covered the
 * screen; the persistent transcript line disappeared underneath it. A ribbon has
 * a FIXED viewport. Text never wraps, never grows the box, and never reflows the
 * unit: when the line outgrows the viewport it slides left so the newest glyph
 * stays pinned at the right inner edge, and the only property that animates
 * while streaming is that translation.
 *
 * Painting by state (see {@link MoaRibbonPresence}):
 * <ul>
 *   <li>dormant  - nothing, view alpha 0</li>
 *   <li>ambient  - one translucent plate while current text is visible</li>
 *   <li>engaged  - a plate appears INSIDE the existing box (fill plus an inset
 *                  hairline), which is why solidifying costs no layout</li>
 *   <li>dragging - the same plate at 70%</li>
 * </ul>
 */
final class MoaRibbonView extends View {
    private final boolean reply;
    private final float density;
    private final Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint strokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fadePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF scratch = new RectF();

    private MoaRibbonTokens.Palette palette = MoaRibbonTokens.DARK;
    private MoaRibbonPresence.State state = MoaRibbonPresence.State.DORMANT;
    private boolean highContrast;
    private String line = "";
    private String fullText = "";
    private boolean expanded;
    private StaticLayout expandedLayout;
    private int toneColor;
    private float plateFraction;
    private float translateX;
    private float caretAlpha;
    private float flashFraction;
    private float dotScale = 1f;
    private boolean caretVisible;
    private boolean listening;
    private ValueAnimator slideAnimator;
    private ValueAnimator plateAnimator;
    private ValueAnimator caretAnimator;
    private ValueAnimator dotAnimator;

    private final int ribbonHeightPx;
    private final int padXPx;
    private final int gutterPx;
    private final int dotSizePx;
    private final int radiusPx;
    private final int scrimRadiusPx;
    private final int hairlinePx;
    private final int fadeWidthPx;
    private final int railWidthPx;
    private final int railHitWidthPx;
    private final int historyRailWidthPx;
    private final int hitInflatePx;
    private final int caretWidthPx;
    private final int caretHeightPx;
    private final int expandedMaxHeightPx;
    private final int expandedPadYPx;

    MoaRibbonView(Context context, boolean reply) {
        super(context);
        this.reply = reply;
        this.density = context.getResources().getDisplayMetrics().density;
        float fontScale = context.getResources().getConfiguration().fontScale;

        ribbonHeightPx = dp(MoaRibbonTokens.ribbonHeightDp(fontScale));
        padXPx = dp(MoaRibbonTokens.RIBBON_PAD_X_DP);
        dotSizePx = dp(MoaRibbonTokens.DOT_SIZE_DP);
        gutterPx = dp(MoaRibbonTokens.DOT_OFFSET_DP) + dotSizePx;
        radiusPx = dp(MoaRibbonTokens.RADIUS_RIBBON_DP);
        scrimRadiusPx = dp(MoaRibbonTokens.RADIUS_SCRIM_DP);
        hairlinePx = Math.max(1, dp(MoaRibbonTokens.HAIRLINE_DP));
        fadeWidthPx = dp(MoaRibbonTokens.FADE_W_DP);
        railWidthPx = dp(MoaRibbonTokens.RAIL_GLYPH_DP + 4);
        railHitWidthPx = dp(MoaRibbonTokens.RAIL_HIT_W_DP);
        historyRailWidthPx = dp(MoaRibbonTokens.HISTORY_RAIL_W_DP);
        hitInflatePx = dp(MoaRibbonTokens.HIT_INFLATE_DP);
        caretWidthPx = Math.max(1, dp(MoaRibbonTokens.CARET_W_DP));
        caretHeightPx = dp(MoaRibbonTokens.CARET_H_DP);
        expandedMaxHeightPx = dp(MoaRibbonTokens.EXPANDED_MAX_H_DP);
        expandedPadYPx = dp(MoaRibbonTokens.EXPANDED_PAD_Y_DP);

        textPaint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        textPaint.setTextSize(MoaRibbonTokens.TEXT_SP
                * MoaRibbonTokens.textScale(fontScale)
                * context.getResources().getDisplayMetrics().scaledDensity);
        textPaint.setLetterSpacing(0.005f);
        strokePaint.setStyle(Paint.Style.STROKE);
        strokePaint.setStrokeWidth(hairlinePx);
        fadePaint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.DST_IN));

        setAlpha(0f);
        setContentDescription(accessibilityLabel());
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
    }

    int ribbonHeightPx() {
        return ribbonHeightPx;
    }

    void setPalette(MoaRibbonTokens.Palette value) {
        palette = value;
        invalidate();
    }

    void setHighContrast(boolean value) {
        highContrast = value;
        invalidate();
    }

    /** Override the ink colour for warnings, errors and "didn't catch that". */
    void setTone(int color) {
        toneColor = color;
        invalidate();
    }

    /**
     * Render a new window of the buffer. The viewport is never resized; only the
     * line's translation moves, so a streaming delta cannot change any element's
     * width, height or position.
     */
    void setWindowText(String value) {
        String next = value == null ? "" : value;
        if (next.equals(line)) {
            return;
        }
        line = next;
        setContentDescription(accessibilityLabel());
        slideToTail();
        invalidate();
    }

    String windowText() {
        return line;
    }

    /**
     * The whole turn, used only by the expanded state. Kept separate from the
     * rendered window so the collapsed ribbon still cannot be widened by content.
     */
    void setFullText(String value) {
        fullText = value == null ? "" : value;
        expandedLayout = null;
        if (expanded) {
            requestLayout();
            invalidate();
        }
    }

    /**
     * Click-to-expand. The collapsed ribbon is a fixed one-line window on the
     * newest text; expanding is how the user reads the rest of it without the
     * overlay ever becoming a chat. Height changes here and only here — a stream
     * delta still may not resize anything.
     */
    void setExpanded(boolean value) {
        if (expanded == value) {
            return;
        }
        expanded = value;
        expandedLayout = null;
        requestLayout();
        invalidate();
    }

    boolean expanded() {
        return expanded;
    }

    /** The window height this ribbon wants right now. Bounded in both states. */
    int desiredHeightPx() {
        if (!expanded) {
            return ribbonHeightPx;
        }
        StaticLayout layout = expandedLayout();
        int content = (layout == null ? 0 : layout.getHeight()) + expandedPadYPx * 2;
        return MoaRibbonUnitLayout.expandedHeight(content, ribbonHeightPx, expandedMaxHeightPx);
    }

    private StaticLayout expandedLayout() {
        int width = Math.round(viewportRight() - viewportLeft());
        if (width <= 0 || fullText.isEmpty()) {
            return null;
        }
        if (expandedLayout == null || expandedLayout.getWidth() != width) {
            TextPaint paint = new TextPaint(textPaint);
            paint.setColor(toneColor != 0 ? toneColor : palette.ink);
            paint.clearShadowLayer();
            expandedLayout = StaticLayout.Builder
                    .obtain(fullText, 0, fullText.length(), paint, width)
                    .setAlignment(Layout.Alignment.ALIGN_NORMAL)
                    .setIncludePad(false)
                    .build();
        }
        return expandedLayout;
    }

    void setPresenceState(MoaRibbonPresence.State next) {
        if (next == state) {
            return;
        }
        MoaRibbonPresence.State previous = state;
        state = next;
        animateTo(MoaRibbonPresence.plateAlpha(state, highContrast),
                MoaRibbonPresence.ribbonAlpha(state),
                MoaRibbonPresence.solidifyDurationMs(previous, state));
    }

    MoaRibbonPresence.State presenceState() {
        return state;
    }

    void setCaretVisible(boolean value) {
        if (caretVisible == value) {
            return;
        }
        caretVisible = value;
        if (caretAnimator != null) {
            caretAnimator.cancel();
            caretAnimator = null;
        }
        if (!value) {
            caretAlpha = 0f;
            invalidate();
            return;
        }
        caretAlpha = 1f;
        if (!ValueAnimator.areAnimatorsEnabled()) {
            invalidate();
            return;
        }
        caretAnimator = ValueAnimator.ofFloat(1f, 0.15f, 1f);
        caretAnimator.setDuration(MoaRibbonTokens.CARET_BLINK_MS);
        caretAnimator.setRepeatCount(ValueAnimator.INFINITE);
        caretAnimator.addUpdateListener(a -> {
            caretAlpha = (float) a.getAnimatedValue();
            invalidate();
        });
        caretAnimator.start();
    }

    /** The speaker dot pulses while this ribbon's capture is open. */
    void setListening(boolean value) {
        if (listening == value) {
            return;
        }
        listening = value;
        if (dotAnimator != null) {
            dotAnimator.cancel();
            dotAnimator = null;
        }
        if (!value || !ValueAnimator.areAnimatorsEnabled()) {
            dotScale = value ? 1.2f : 1f;
            invalidate();
            return;
        }
        dotAnimator = ValueAnimator.ofFloat(1f, 1.35f, 1f);
        dotAnimator.setDuration(1200);
        dotAnimator.setRepeatCount(ValueAnimator.INFINITE);
        dotAnimator.addUpdateListener(a -> {
            dotScale = (float) a.getAnimatedValue();
            invalidate();
        });
        dotAnimator.start();
    }

    /** Double-tap acknowledgement: a short accent wash, no layout change. */
    void flash() {
        if (!ValueAnimator.areAnimatorsEnabled()) {
            return;
        }
        ValueAnimator flash = ValueAnimator.ofFloat(0.12f, 0f);
        flash.setDuration(MoaRibbonTokens.FLASH_MS);
        flash.addUpdateListener(a -> {
            flashFraction = (float) a.getAnimatedValue();
            invalidate();
        });
        flash.start();
    }

    // --- Hit testing ------------------------------------------------------

    /**
     * Whether a touch at this point should be taken by the ribbon.
     *
     * In ambient the answer is "only if you are on the glyphs", inflated by 8dp:
     * an empty ribbon has a zero-area hit region and is completely inert. Once
     * engaged the whole plate is a handle, because by then the user has already
     * declared intent.
     */
    boolean hitsInteractive(float x, float y) {
        if (expanded) {
            return x >= gutterPx - hitInflatePx && x <= getWidth() && y >= 0 && y <= getHeight();
        }
        if (state == MoaRibbonPresence.State.ENGAGED || state == MoaRibbonPresence.State.DRAGGING) {
            return x >= gutterPx - hitInflatePx && x <= getWidth() && y >= 0 && y <= getHeight();
        }
        if (line.isEmpty()) {
            return false;
        }
        float left = glyphLeft() - hitInflatePx;
        float right = glyphRight() + hitInflatePx;
        return x >= left && x <= right && y >= -hitInflatePx && y <= getHeight() + hitInflatePx;
    }

    /** The copy rail, revealed only in engaged. Hit box is padded, paint is not. */
    boolean hitsRail(float x, float y) {
        if (!expanded && !MoaRibbonPresence.railVisible(state)) {
            return false;
        }
        float bottom = expanded ? ribbonHeightPx : getHeight();
        return x >= getWidth() - railHitWidthPx && x <= getWidth() && y >= 0 && y <= bottom;
    }

    /** Expanded-only history button beside copy; history remains a full-app surface. */
    boolean hitsHistory(float x, float y) {
        if (!expanded) {
            return false;
        }
        float right = getWidth() - railHitWidthPx;
        return x >= right - historyRailWidthPx && x < right && y >= 0 && y <= ribbonHeightPx;
    }

    private float viewportLeft() {
        return gutterPx + padXPx;
    }

    private float viewportRight() {
        float rail = MoaRibbonPresence.railVisible(state) ? railWidthPx : 0;
        if (expanded) rail += historyRailWidthPx;
        return Math.max(viewportLeft(), getWidth() - padXPx - rail);
    }

    private float glyphLeft() {
        return Math.max(viewportLeft(), viewportLeft() + translateX);
    }

    private float glyphRight() {
        return Math.min(viewportRight(), viewportLeft() + translateX + textWidth());
    }

    private float textWidth() {
        return line.isEmpty() ? 0f : textPaint.measureText(line);
    }

    // --- Slide ------------------------------------------------------------

    private void slideToTail() {
        float target = Math.min(0f, (viewportRight() - viewportLeft()) - textWidth());
        if (slideAnimator != null) {
            slideAnimator.cancel();
            slideAnimator = null;
        }
        if (!ValueAnimator.areAnimatorsEnabled()) {
            translateX = target;
            return;
        }
        slideAnimator = ValueAnimator.ofFloat(translateX, target);
        slideAnimator.setDuration(MoaRibbonTokens.DUR_SLIDE_MS);
        slideAnimator.setInterpolator(null);
        slideAnimator.addUpdateListener(a -> {
            translateX = (float) a.getAnimatedValue();
            invalidate();
        });
        slideAnimator.start();
    }

    private void animateTo(float targetPlate, float targetAlpha, long durationMs) {
        if (plateAnimator != null) {
            plateAnimator.cancel();
            plateAnimator = null;
        }
        animate().cancel();
        if (!ValueAnimator.areAnimatorsEnabled()) {
            plateFraction = targetPlate;
            setAlpha(targetAlpha);
            invalidate();
            return;
        }
        animate().alpha(targetAlpha).setDuration(durationMs).start();
        plateAnimator = ValueAnimator.ofFloat(plateFraction, targetPlate);
        plateAnimator.setDuration(durationMs);
        plateAnimator.addUpdateListener(a -> {
            plateFraction = (float) a.getAnimatedValue();
            invalidate();
        });
        plateAnimator.start();
    }

    // --- Paint ------------------------------------------------------------

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), desiredHeightPx());
    }

    @Override
    protected void onDraw(Canvas canvas) {
        if (getWidth() == 0) {
            return;
        }
        if (plateFraction > 0.01f) {
            drawPlate(canvas);
        }
        drawDot(canvas);
        if (flashFraction > 0.001f) {
            fillPaint.setShader(null);
            fillPaint.setColor(withAlpha(palette.accent, flashFraction));
            scratch.set(0, 0, getWidth(), getHeight());
            canvas.drawRoundRect(scratch, radiusPx, radiusPx, fillPaint);
        }
        if (expanded) {
            drawExpanded(canvas);
            return;
        }
        if (line.isEmpty()) {
            return;
        }
        boolean scrim = MoaRibbonPresence.scrimVisible(state, highContrast) && plateFraction <= 0.01f;
        if (scrim) {
            drawScrim(canvas);
        }
        drawLine(canvas, scrim);
        if (MoaRibbonPresence.railVisible(state)) {
            drawRail(canvas);
        }
    }

    // The expanded read: the full turn, wrapped, on a plate, scrolled to nothing
    // and bounded by EXPANDED_MAX_H_DP. The copy rail stays reachable, because
    // expanding is exactly when the user wants to take the text.
    private void drawExpanded(Canvas canvas) {
        StaticLayout layout = expandedLayout();
        if (layout == null) {
            return;
        }
        canvas.save();
        canvas.clipRect(viewportLeft(), expandedPadYPx, viewportRight(), getHeight() - expandedPadYPx);
        canvas.translate(viewportLeft(), expandedPadYPx);
        // Longer than the bound: show the TAIL, same rule as the collapsed line.
        int overflow = layout.getHeight() - (getHeight() - expandedPadYPx * 2);
        if (overflow > 0) {
            canvas.translate(0, -overflow);
        }
        layout.draw(canvas);
        canvas.restore();
        drawHistory(canvas);
        drawRail(canvas);
    }

    private void drawDot(Canvas canvas) {
        fillPaint.setShader(null);
        fillPaint.setColor(reply ? palette.agent : palette.you);
        float cy = expanded ? ribbonHeightPx / 2f : getHeight() / 2f;
        canvas.drawCircle(dotSizePx, cy, dotSizePx / 2f * dotScale, fillPaint);
    }

    private void drawPlate(Canvas canvas) {
        scratch.set(0, 0, getWidth(), getHeight());
        fillPaint.setShader(null);
        fillPaint.setColor(withAlpha(
                state == MoaRibbonPresence.State.DRAGGING ? palette.plateDrag : palette.plate,
                plateFraction));
        canvas.drawRoundRect(scratch, radiusPx, radiusPx, fillPaint);
        // The border is drawn INSIDE the box so solidifying never costs layout.
        strokePaint.setColor(withAlpha(palette.hairline, plateFraction));
        scratch.inset(hairlinePx / 2f, hairlinePx / 2f);
        canvas.drawRoundRect(scratch, radiusPx, radiusPx, strokePaint);
    }

    private void drawScrim(Canvas canvas) {
        float left = Math.max(gutterPx, glyphLeft() - dp(4));
        float right = Math.min(getWidth(), glyphRight() + dp(4));
        if (right <= left) {
            return;
        }
        float half = (textPaint.descent() - textPaint.ascent()) / 2f + dp(1);
        scratch.set(left, getHeight() / 2f - half, right, getHeight() / 2f + half);
        fillPaint.setShader(null);
        fillPaint.setColor(palette.scrim);
        canvas.drawRoundRect(scratch, scrimRadiusPx, scrimRadiusPx, fillPaint);
    }

    private void drawLine(Canvas canvas, boolean halo) {
        int ink = toneColor != 0
                ? toneColor
                : (state == MoaRibbonPresence.State.AMBIENT ? palette.inkAmbient : palette.ink);
        textPaint.setColor(ink);
        if (halo) {
            textPaint.setShadowLayer(dp(4), 0, dp(1), palette.halo);
        } else {
            textPaint.clearShadowLayer();
        }

        float left = viewportLeft();
        float right = viewportRight();
        float baseline = getHeight() / 2f - (textPaint.descent() + textPaint.ascent()) / 2f;
        boolean fade = translateX < -0.5f;

        int layer = canvas.saveLayer(left - fadeWidthPx, 0, right, getHeight(), null);
        canvas.save();
        canvas.clipRect(left, 0, right, getHeight());
        canvas.drawText(line, left + translateX, baseline, textPaint);
        canvas.restore();
        if (fade) {
            // The left mask IS the truncation indicator; no ellipsis is prepended.
            fadePaint.setShader(new LinearGradient(
                    left, 0, left + fadeWidthPx, 0, 0x00000000, 0xFF000000, Shader.TileMode.CLAMP));
            canvas.drawRect(left, 0, left + fadeWidthPx, getHeight(), fadePaint);
        }
        canvas.restoreToCount(layer);

        if (caretVisible && caretAlpha > 0.01f) {
            float caretX = Math.min(right - caretWidthPx, left + translateX + textWidth() + dp(2));
            fillPaint.setShader(null);
            fillPaint.setColor(withAlpha(palette.accent, caretAlpha));
            scratch.set(caretX, (getHeight() - caretHeightPx) / 2f,
                    caretX + caretWidthPx, (getHeight() + caretHeightPx) / 2f);
            canvas.drawRoundRect(scratch, caretWidthPx / 2f, caretWidthPx / 2f, fillPaint);
        }
    }

    /** The copy glyph: two offset rounded outlines. One button, nothing else. */
    private void drawRail(Canvas canvas) {
        float size = dp(9);
        float cx = getWidth() - padXPx - size;
        float cy = expanded ? ribbonHeightPx / 2f : getHeight() / 2f;
        strokePaint.setColor(palette.muted);
        scratch.set(cx - size / 2f - dp(1.5f), cy - size / 2f - dp(1.5f),
                cx + size / 2f - dp(1.5f), cy + size / 2f - dp(1.5f));
        canvas.drawRoundRect(scratch, dp(2), dp(2), strokePaint);
        strokePaint.setColor(palette.ink);
        scratch.set(cx - size / 2f + dp(1.5f), cy - size / 2f + dp(1.5f),
                cx + size / 2f + dp(1.5f), cy + size / 2f + dp(1.5f));
        canvas.drawRoundRect(scratch, dp(2), dp(2), strokePaint);
        strokePaint.setColor(palette.hairline);
    }

    /** Explicit full-app History handoff, never inline chat. */
    private void drawHistory(Canvas canvas) {
        float right = getWidth() - railHitWidthPx;
        float left = right - historyRailWidthPx;
        float cx = left + dp(9);
        float cy = ribbonHeightPx / 2f;
        float radius = dp(4.5f);
        strokePaint.setColor(palette.ink);
        canvas.drawCircle(cx, cy, radius, strokePaint);
        canvas.drawLine(cx, cy, cx, cy - dp(3), strokePaint);
        canvas.drawLine(cx, cy, cx + dp(2.5f), cy + dp(1.5f), strokePaint);
        textPaint.clearShadowLayer();
        textPaint.setColor(palette.ink);
        canvas.drawText("History", left + dp(18),
                cy - (textPaint.descent() + textPaint.ascent()) / 2f, textPaint);
        strokePaint.setColor(palette.hairline);
    }

    @Override
    public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(info);
        info.setClassName("android.widget.Button");
        info.setContentDescription(accessibilityLabel());
    }

    private String accessibilityLabel() {
        String speaker = reply ? "AG reply" : "You said";
        String body = line.isEmpty() ? "nothing yet" : line;
        // A screen-reader user cannot discover a long press on a floating window,
        // so the gestures are named. The hold menu rows are also exposed as
        // custom actions by OverlayService.
        return speaker + ": " + body
                + ". Tap to expand. Expanded controls copy the turn or open full history.";
    }

    private int withAlpha(int color, float fraction) {
        int base = (color >>> 24) & 0xFF;
        int alpha = Math.max(0, Math.min(255, Math.round(base * Math.max(0f, Math.min(1f, fraction)))));
        return (alpha << 24) | (color & 0x00FFFFFF);
    }

    private int dp(float value) {
        return Math.round(value * density);
    }

    void release() {
        if (slideAnimator != null) slideAnimator.cancel();
        if (plateAnimator != null) plateAnimator.cancel();
        if (caretAnimator != null) caretAnimator.cancel();
        if (dotAnimator != null) dotAnimator.cancel();
        slideAnimator = null;
        plateAnimator = null;
        caretAnimator = null;
        dotAnimator = null;
    }
}
