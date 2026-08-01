package ag.companion;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.Layout;
import android.text.SpannableString;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.style.ForegroundColorSpan;
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
 * The user bubble keeps one visible Copy action. Copy finishes a live capture
 * through the host before copying the authoritative final transcript. History
 * remains in the full app so the compact surface does not become a toolbar.
 * The you-bubble's plate is deliberately near-black in BOTH system themes
 * ({@link MoaRibbonTokens#plateColor}), so its text always uses the paired
 * light ink ({@link MoaRibbonTokens#inkColor}) — never the theme's plain
 * {@code palette.ink}, which is dark in light theme and would vanish against
 * that near-black plate.
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
    private final Paint actionPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
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
    private int highlightStart = -1;
    private String collapsedSpokenText = "";
    private boolean collapsedSpokenActive;
    private ValueAnimator plateAnimator;
    private ValueAnimator caretAnimator;
    private ValueAnimator dotAnimator;
    private Runnable accessibilityTap;
    private Runnable accessibilityCopy;

    private final int ribbonHeightPx;
    private final int padXPx;
    private final int gutterPx;
    private final int dotSizePx;
    private final int radiusPx;
    private final int hairlinePx;
    private final int hitInflatePx;
    private final int caretWidthPx;
    private final int caretHeightPx;
    private final int expandedMaxHeightPx;
    private final int padYPx;
    private final int copyRailWidthPx;

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
        hitInflatePx = dp(MoaRibbonTokens.HIT_INFLATE_DP);
        caretWidthPx = Math.max(1, dp(MoaRibbonTokens.CARET_W_DP));
        caretHeightPx = dp(MoaRibbonTokens.CARET_H_DP);
        expandedMaxHeightPx = dp(MoaRibbonTokens.EXPANDED_MAX_H_DP);
        padYPx = dp(MoaRibbonTokens.EXPANDED_PAD_Y_DP);
        copyRailWidthPx = dp(MoaRibbonTokens.COPY_RAIL_W_DP);

        textPaint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        textPaint.setTextSize(MoaRibbonTokens.TEXT_SP
                * MoaRibbonTokens.textScale(fontScale)
                * context.getResources().getDisplayMetrics().scaledDensity);
        textPaint.setLetterSpacing(0.005f);
        actionPaint.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        actionPaint.setTextSize(10f * context.getResources().getDisplayMetrics().scaledDensity);
        actionPaint.setTextAlign(Paint.Align.CENTER);
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
        accessibilityCopy = reply ? null : copy;
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
        if (!expanded && !collapsedSpokenActive) {
            textLayout = null;
            requestLayout();
        }
        setContentDescription(accessibilityLabel());
        invalidate();
    }

    String windowText() {
        return line;
    }

    /** The whole retained turn: expansion and the full-app History surface use it. */
    void setFullText(String value) {
        String next = value == null ? "" : value;
        if (next.equals(fullText)) {
            return;
        }
        fullText = next;
        // The collapsed surface paints only the bounded tail window. Retaining
        // another streaming delta must not rebuild and remeasure the complete
        // turn on the UI thread. Expansion is the only state that lays out the
        // full retained text.
        if (expanded || line.isEmpty()) {
            textLayout = null;
            requestLayout();
        }
        invalidate();
        sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
    }

    void setHighlightStart(int value) {
        int next = value < 0 || value >= displayedText().length() ? -1 : value;
        if (highlightStart == next) return;
        highlightStart = next;
        textLayout = null;
        invalidate();
    }

    /**
     * Collapsed paint-time override for a spoken reply: the collapsed bubble
     * shows only the text the AudioTrack playback head has actually crossed,
     * while {@link #setFullText} retains the complete response for expansion
     * and History. Never active outside a live hosted-audio reply.
     */
    void setCollapsedSpoken(String text, boolean active) {
        String next = text == null ? "" : text;
        if (collapsedSpokenActive == active && next.equals(collapsedSpokenText)) {
            return;
        }
        collapsedSpokenText = next;
        collapsedSpokenActive = active;
        textLayout = null;
        requestLayout();
        invalidate();
    }

    /** What the bounded viewport wraps right now. */
    private String displayedText() {
        if (expanded) {
            return fullText;
        }
        if (collapsedSpokenActive) {
            return collapsedSpokenText;
        }
        return line.isEmpty() ? fullText : line;
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
        String shown = displayedText();
        if (width <= 0 || shown.isEmpty()) {
            return null;
        }
        if (textLayout == null || textLayout.getWidth() != width) {
            TextPaint paint = new TextPaint(textPaint);
            paint.setColor(toneColor != 0
                    ? toneColor : MoaRibbonTokens.inkColor(palette, reply));
            CharSequence display = shown;
            if (highlightStart >= 0 && highlightStart < shown.length()) {
                SpannableString highlighted = new SpannableString(shown);
                highlighted.setSpan(new ForegroundColorSpan(palette.accent),
                        highlightStart, shown.length(), SpannableString.SPAN_EXCLUSIVE_EXCLUSIVE);
                display = highlighted;
            }
            textLayout = StaticLayout.Builder
                    .obtain(display, 0, display.length(), paint, width)
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

    boolean hitsRail(float x, float y) {
        return copyVisible()
                && x >= copyRailLeft()
                && x <= getWidth()
                && y >= 0
                && y <= getHeight();
    }

    /** Kept for the touch listener contract; History is a full-app surface. */
    boolean hitsHistory(float x, float y) {
        return false;
    }

    private float viewportLeft() {
        return gutterPx + padXPx;
    }

    private float viewportRight() {
        int width = getWidth() > 0 ? getWidth() : contentWidthPx;
        int actionInset = reply ? 0 : copyRailWidthPx;
        return Math.max(viewportLeft(), width - padXPx - actionInset);
    }

    /**
     * The width in px that the wrapped turn text is laid out into: the fixed
     * window minus the gutter and padding. This is the geometry the browser
     * overlay mirrors.
     */
    int textViewportWidthPx() {
        return Math.round(viewportRight() - viewportLeft());
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
        drawCopyAction(canvas);
    }

    private void drawCopyAction(Canvas canvas) {
        if (!copyVisible()) {
            return;
        }
        float left = copyRailLeft();
        strokePaint.setColor(withAlpha(palette.hairline, Math.max(plateFraction, 0.55f)));
        canvas.drawLine(left, padYPx, left, getHeight() - padYPx, strokePaint);
        actionPaint.setColor(palette.accent);
        Paint.FontMetrics metrics = actionPaint.getFontMetrics();
        float baseline = getHeight() / 2f - (metrics.ascent + metrics.descent) / 2f;
        canvas.drawText("COPY", left + copyRailWidthPx / 2f, baseline, actionPaint);
    }

    private boolean copyVisible() {
        return !reply && !fullText.isEmpty();
    }

    private float copyRailLeft() {
        int width = getWidth() > 0 ? getWidth() : contentWidthPx;
        return Math.max(0, width - copyRailWidthPx);
    }

    // One paint path for both states: the wrapped turn inside a bounded
    // viewport. Collapsed pins to the TAIL, the same rule as the old sliding
    // line; expanded honours the user's scroll and defaults to the tail.
    private void drawText(Canvas canvas) {
        StaticLayout layout = textLayout();
        if (layout == null) {
            if (caretVisible && caretAlpha > 0.01f) {
                fillPaint.setShader(null);
                fillPaint.setColor(withAlpha(palette.accent, caretAlpha));
                float x = viewportLeft();
                float mid = ribbonHeightPx / 2f;
                scratch.set(x, mid - caretHeightPx / 2f,
                        x + caretWidthPx, mid + caretHeightPx / 2f);
                canvas.drawRoundRect(scratch, caretWidthPx / 2f, caretWidthPx / 2f, fillPaint);
            }
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
                MoaRibbonTokens.plateColor(
                        palette, reply, state == MoaRibbonPresence.State.DRAGGING),
                plateFraction));
        canvas.drawRoundRect(scratch, radiusPx, radiusPx, fillPaint);
        // The border is drawn INSIDE the box so solidifying never costs layout.
        strokePaint.setColor(withAlpha(palette.hairline, plateFraction));
        scratch.inset(hairlinePx / 2f, hairlinePx / 2f);
        canvas.drawRoundRect(scratch, radiusPx, radiusPx, strokePaint);
    }

    @Override
    public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(info);
        info.setClassName("android.widget.Button");
        info.setContentDescription(accessibilityLabel());
        info.setClickable(true);
        info.addAction(new AccessibilityNodeInfo.AccessibilityAction(
                AccessibilityNodeInfo.ACTION_CLICK, expanded ? "Collapse" : "Expand"));
        if (copyVisible()) {
            info.addAction(new AccessibilityNodeInfo.AccessibilityAction(
                    AccessibilityNodeInfo.ACTION_COPY, "Copy"));
        }
    }

    @Override
    public boolean performAccessibilityAction(int action, Bundle arguments) {
        if (action == AccessibilityNodeInfo.ACTION_CLICK && accessibilityTap != null) {
            accessibilityTap.run();
            return true;
        }
        if (action == AccessibilityNodeInfo.ACTION_COPY
                && copyVisible()
                && accessibilityCopy != null) {
            accessibilityCopy.run();
            return true;
        }
        return super.performAccessibilityAction(action, arguments);
    }

    private String accessibilityLabel() {
        String speaker = reply ? "Ag reply" : "You said";
        String body = line.isEmpty() ? "nothing yet" : line;
        return speaker + ": " + body + ". Tap to expand."
                + (copyVisible() ? " Copy available." : "");
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
    }
}
