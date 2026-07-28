package ai.moa.assistant;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.view.View;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * One ribbon: a compact translucent chat bubble for the current turn.
 *
 * This is the whole anti-occlusion fix. The old voice card was a filled,
 * bordered, scrolling rectangle that grew with the conversation and covered the
 * screen. A bubble has a BOUNDED viewport: collapsed it wraps the turn up to
 * {@link MoaRibbonTokens#COLLAPSED_MAX_LINES} lines and then pins to the tail;
 * a tap expands it to a taller, still-bounded, vertically scrollable read.
 * Nothing here may become a chat panel.
 *
 * Actions are explicit, not gestures: the you-bubble shows exactly one Copy
 * button and one History button whenever it holds text. The reply bubble keeps
 * its copy rail behind engagement as before.
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
    private static final int ACTION_COPY = View.generateViewId();
    private static final int ACTION_HISTORY = View.generateViewId();

    private final boolean reply;
    private final float density;
    private final Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint strokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF scratch = new RectF();

    private MoaRibbonTokens.Palette palette = MoaRibbonTokens.DARK;
    private MoaRibbonPresence.State state = MoaRibbonPresence.State.DORMANT;
    private boolean highContrast;
    private String line = "";
    private String fullText = "";
    private boolean expanded;
    private StaticLayout textLayout;
    private int contentWidthPx;
    /** Pixels scrolled from the top of expanded content; -1 pins to the tail. */
    private int expandedScrollY = -1;
    private int toneColor;
    private float plateFraction;
    private float caretAlpha;
    private float flashFraction;
    private float dotScale = 1f;
    private boolean caretVisible;
    private boolean listening;
    private ValueAnimator plateAnimator;
    private ValueAnimator caretAnimator;
    private ValueAnimator dotAnimator;
    private Runnable accessibilityTap;
    private Runnable accessibilityCopy;
    private Runnable accessibilityHistory;

    private final int ribbonHeightPx;
    private final int padXPx;
    private final int gutterPx;
    private final int dotSizePx;
    private final int radiusPx;
    private final int hairlinePx;
    private final int railWidthPx;
    private final int railHitWidthPx;
    private final int hitInflatePx;
    private final int caretWidthPx;
    private final int caretHeightPx;
    private final int expandedMaxHeightPx;
    private final int padYPx;

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
        hairlinePx = Math.max(1, dp(MoaRibbonTokens.HAIRLINE_DP));
        railWidthPx = dp(MoaRibbonTokens.RAIL_GLYPH_DP + 4);
        railHitWidthPx = dp(MoaRibbonTokens.RAIL_HIT_W_DP);
        hitInflatePx = dp(MoaRibbonTokens.HIT_INFLATE_DP);
        caretWidthPx = Math.max(1, dp(MoaRibbonTokens.CARET_W_DP));
        caretHeightPx = dp(MoaRibbonTokens.CARET_H_DP);
        expandedMaxHeightPx = dp(MoaRibbonTokens.EXPANDED_MAX_H_DP);
        padYPx = dp(MoaRibbonTokens.EXPANDED_PAD_Y_DP);

        textPaint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        textPaint.setTextSize(MoaRibbonTokens.TEXT_SP
                * MoaRibbonTokens.textScale(fontScale)
                * context.getResources().getDisplayMetrics().scaledDensity);
        textPaint.setLetterSpacing(0.005f);
        strokePaint.setStyle(Paint.Style.STROKE);
        strokePaint.setStrokeWidth(hairlinePx);

        setAlpha(0f);
        setContentDescription(accessibilityLabel());
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
    }

    int ribbonHeightPx() {
        return ribbonHeightPx;
    }

    void setAccessibilityActions(Runnable tap, Runnable copy, Runnable history) {
        accessibilityTap = tap;
        accessibilityCopy = copy;
        accessibilityHistory = history;
        sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
    }

    /**
     * The fixed window width this bubble is laid out into. The controller knows
     * it before the view is ever measured, so the first frame's wrap and height
     * are already correct.
     */
    void setContentWidth(int px) {
        if (contentWidthPx == px) {
            return;
        }
        contentWidthPx = px;
        textLayout = null;
        requestLayout();
        invalidate();
    }

    void setPalette(MoaRibbonTokens.Palette value) {
        if (palette == value) {
            return;
        }
        palette = value;
        textLayout = null;
        invalidate();
    }

    void setHighContrast(boolean value) {
        highContrast = value;
        invalidate();
    }

    /** Override the ink colour for warnings, errors and "didn't catch that". */
    void setTone(int color) {
        toneColor = color;
        textLayout = null;
        invalidate();
    }

    /**
     * The newest tail window of the turn, used for the spoken accessibility
     * label so a screen reader is not handed 8000 characters.
     */
    void setWindowText(String value) {
        String next = value == null ? "" : value;
        if (next.equals(line)) {
            return;
        }
        line = next;
        setContentDescription(accessibilityLabel());
        invalidate();
    }

    String windowText() {
        return line;
    }

    /** The whole retained turn: what the bubble wraps and what Copy takes. */
    void setFullText(String value) {
        String next = value == null ? "" : value;
        if (next.equals(fullText)) {
            return;
        }
        fullText = next;
        textLayout = null;
        requestLayout();
        invalidate();
        sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
    }

    /**
     * Click-to-expand. Collapsed is a bounded few-line window on the newest
     * text; expanding is how the user reads the rest without the overlay ever
     * becoming a chat. Height changes here and on stream growth up to the
     * collapsed line cap — never past either bound.
     */
    void setExpanded(boolean value) {
        if (expanded == value) {
            return;
        }
        expanded = value;
        expandedScrollY = -1;
        textLayout = null;
        requestLayout();
        invalidate();
        sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
    }

    boolean expanded() {
        return expanded;
    }

    /** The window height this bubble wants right now. Bounded in both states. */
    int desiredHeightPx() {
        StaticLayout layout = textLayout();
        int content = (layout == null ? 0 : layout.getHeight()) + padYPx * 2;
        if (expanded) {
            return MoaRibbonUnitLayout.expandedHeight(content, ribbonHeightPx, expandedMaxHeightPx);
        }
        return MoaRibbonUnitLayout.collapsedHeight(
                content, ribbonHeightPx, lineHeightPx(), padYPx);
    }

    private int lineHeightPx() {
        return Math.round(textPaint.descent() - textPaint.ascent());
    }

    private StaticLayout textLayout() {
        int width = Math.round(viewportRight() - viewportLeft());
        if (width <= 0 || fullText.isEmpty()) {
            return null;
        }
        if (textLayout == null || textLayout.getWidth() != width) {
            TextPaint paint = new TextPaint(textPaint);
            paint.setColor(toneColor != 0 ? toneColor : palette.ink);
            textLayout = StaticLayout.Builder
                    .obtain(fullText, 0, fullText.length(), paint, width)
                    .setAlignment(Layout.Alignment.ALIGN_NORMAL)
                    .setIncludePad(false)
                    .build();
        }
        return textLayout;
    }

    void setPresenceState(MoaRibbonPresence.State next) {
        if (next == state) {
            return;
        }
        boolean copyWasVisible = copyRailVisible();
        boolean historyWasVisible = historyRailVisible();
        MoaRibbonPresence.State previous = state;
        state = next;
        if (copyWasVisible != copyRailVisible() || historyWasVisible != historyRailVisible()) {
            textLayout = null;
            requestLayout();
            sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
        }
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

    /** Action acknowledgement: a short accent wash, no layout change. */
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

    // --- Expanded scroll ----------------------------------------------------

    boolean canScrollExpanded() {
        return expanded && contentOverflowPx() > 0;
    }

    /**
     * Finger-follows scroll inside the expanded bubble: a downward finger
     * (positive delta) reveals earlier text. Clamped at both ends.
     */
    void scrollExpandedBy(float fingerDy) {
        int overflow = contentOverflowPx();
        if (overflow <= 0) {
            return;
        }
        int current = expandedScrollY < 0 ? overflow : expandedScrollY;
        StaticLayout layout = textLayout();
        int contentHeight = layout == null ? 0 : layout.getHeight();
        expandedScrollY = MoaRibbonUnitLayout.clampScroll(
                Math.round(current - fingerDy), contentHeight, viewportHeightPx());
        invalidate();
    }

    private int contentOverflowPx() {
        StaticLayout layout = textLayout();
        if (layout == null) {
            return 0;
        }
        return Math.max(0, layout.getHeight() - viewportHeightPx());
    }

    private int viewportHeightPx() {
        int height = getHeight() > 0 ? getHeight() : desiredHeightBoundPx();
        return Math.max(0, height - padYPx * 2);
    }

    /** The state's height ceiling, used before the first real layout pass. */
    private int desiredHeightBoundPx() {
        if (expanded) {
            return expandedMaxHeightPx;
        }
        return Math.max(ribbonHeightPx,
                MoaRibbonTokens.COLLAPSED_MAX_LINES * lineHeightPx() + padYPx * 2);
    }

    // --- Hit testing ------------------------------------------------------

    /**
     * Whether a touch at this point should be taken by the bubble. With text the
     * whole painted plate is interactive; an empty ribbon has a zero-area hit
     * region and is completely inert, so the app underneath keeps its touches.
     */
    boolean hitsInteractive(float x, float y) {
        if (fullText.isEmpty()
                && state != MoaRibbonPresence.State.ENGAGED
                && state != MoaRibbonPresence.State.DRAGGING) {
            return false;
        }
        return x >= gutterPx - hitInflatePx && x <= getWidth() && y >= 0 && y <= getHeight();
    }

    /** The one Copy button. Hit box is padded, paint is not. */
    boolean hitsRail(float x, float y) {
        if (!copyRailVisible()) {
            return false;
        }
        return x >= getWidth() - railHitWidthPx && x <= getWidth()
                && y >= 0 && y <= ribbonHeightPx;
    }

    /** The one History button beside Copy; history remains a full-app surface. */
    boolean hitsHistory(float x, float y) {
        if (!historyRailVisible()) {
            return false;
        }
        float right = getWidth() - railHitWidthPx;
        return x >= right - railHitWidthPx && x < right && y >= 0 && y <= ribbonHeightPx;
    }

    /**
     * The you-bubble's Copy and History are persistent whenever it has text —
     * exactly one visible copy affordance, no menu and no hidden gesture. The
     * reply bubble keeps its copy rail behind engagement.
     */
    private boolean copyRailVisible() {
        if (fullText.isEmpty()) {
            return false;
        }
        return !reply || expanded || MoaRibbonPresence.railVisible(state);
    }

    private boolean historyRailVisible() {
        if (fullText.isEmpty()) {
            return false;
        }
        return !reply || expanded;
    }

    private float viewportLeft() {
        return gutterPx + padXPx;
    }

    private float viewportRight() {
        float rail = copyRailVisible() ? railWidthPx : 0;
        if (historyRailVisible()) {
            rail += railWidthPx;
        }
        int width = getWidth() > 0 ? getWidth() : contentWidthPx;
        return Math.max(viewportLeft(), width - padXPx - rail);
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
        drawText(canvas);
        if (historyRailVisible()) {
            drawHistory(canvas);
        }
        if (copyRailVisible()) {
            drawRail(canvas);
        }
    }

    // One paint path for both states: the wrapped turn inside a bounded
    // viewport. Collapsed pins to the TAIL, the same rule as the old sliding
    // line; expanded honours the user's scroll and defaults to the tail.
    private void drawText(Canvas canvas) {
        StaticLayout layout = textLayout();
        if (layout == null) {
            return;
        }
        float top = padYPx;
        float bottom = getHeight() - padYPx;
        int viewport = Math.round(bottom - top);
        int overflow = Math.max(0, layout.getHeight() - viewport);
        int scroll = expanded && expandedScrollY >= 0
                ? MoaRibbonUnitLayout.clampScroll(expandedScrollY, layout.getHeight(), viewport)
                : overflow;
        canvas.save();
        canvas.clipRect(viewportLeft(), top, viewportRight(), bottom);
        canvas.translate(viewportLeft(), top - scroll);
        layout.draw(canvas);
        if (caretVisible && caretAlpha > 0.01f) {
            int last = layout.getLineCount() - 1;
            float caretX = Math.min(layout.getWidth() - caretWidthPx,
                    layout.getLineWidth(last) + dp(2));
            float caretMid = (layout.getLineTop(last) + layout.getLineBottom(last)) / 2f;
            fillPaint.setShader(null);
            fillPaint.setColor(withAlpha(palette.accent, caretAlpha));
            scratch.set(caretX, caretMid - caretHeightPx / 2f,
                    caretX + caretWidthPx, caretMid + caretHeightPx / 2f);
            canvas.drawRoundRect(scratch, caretWidthPx / 2f, caretWidthPx / 2f, fillPaint);
        }
        canvas.restore();
    }

    private void drawDot(Canvas canvas) {
        fillPaint.setShader(null);
        fillPaint.setColor(reply ? palette.agent : palette.you);
        canvas.drawCircle(dotSizePx, ribbonHeightPx / 2f, dotSizePx / 2f * dotScale, fillPaint);
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

    /** The copy glyph: two offset rounded outlines. One button, nothing else. */
    private void drawRail(Canvas canvas) {
        float size = dp(9);
        float cx = getWidth() - padXPx - size;
        float cy = ribbonHeightPx / 2f;
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

    /** The history glyph: a clock face. Explicit full-app handoff, never inline chat. */
    private void drawHistory(Canvas canvas) {
        float cx = getWidth() - railHitWidthPx - railHitWidthPx / 2f;
        float cy = ribbonHeightPx / 2f;
        float radius = dp(4.5f);
        strokePaint.setColor(palette.ink);
        canvas.drawCircle(cx, cy, radius, strokePaint);
        canvas.drawLine(cx, cy, cx, cy - dp(3), strokePaint);
        canvas.drawLine(cx, cy, cx + dp(2.5f), cy + dp(1.5f), strokePaint);
        strokePaint.setColor(palette.hairline);
    }

    @Override
    public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(info);
        info.setClassName("android.widget.Button");
        info.setContentDescription(accessibilityLabel());
        info.setClickable(true);
        info.addAction(new AccessibilityNodeInfo.AccessibilityAction(
                AccessibilityNodeInfo.ACTION_CLICK, expanded ? "Collapse" : "Expand"));
        if (copyRailVisible()) {
            info.addAction(new AccessibilityNodeInfo.AccessibilityAction(ACTION_COPY, "Copy"));
        }
        if (historyRailVisible()) {
            info.addAction(new AccessibilityNodeInfo.AccessibilityAction(ACTION_HISTORY, "History"));
        }
    }

    @Override
    public boolean performAccessibilityAction(int action, Bundle arguments) {
        if (action == AccessibilityNodeInfo.ACTION_CLICK && accessibilityTap != null) {
            accessibilityTap.run();
            return true;
        }
        if (action == ACTION_COPY && copyRailVisible() && accessibilityCopy != null) {
            accessibilityCopy.run();
            return true;
        }
        if (action == ACTION_HISTORY && historyRailVisible() && accessibilityHistory != null) {
            accessibilityHistory.run();
            return true;
        }
        return super.performAccessibilityAction(action, arguments);
    }

    private String accessibilityLabel() {
        String speaker = reply ? "AG reply" : "You said";
        String body = line.isEmpty() ? "nothing yet" : line;
        // A screen-reader user cannot discover buttons on a floating window, so
        // the affordances are named. The Copy and History buttons sit at the
        // bubble's right edge whenever it holds text.
        return speaker + ": " + body
                + ". Tap to expand. Copy and History buttons are at the right edge.";
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
        if (plateAnimator != null) plateAnimator.cancel();
        if (caretAnimator != null) caretAnimator.cancel();
        if (dotAnimator != null) dotAnimator.cancel();
        plateAnimator = null;
        caretAnimator = null;
        dotAnimator = null;
        accessibilityTap = null;
        accessibilityCopy = null;
        accessibilityHistory = null;
    }
}
