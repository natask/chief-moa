package ag.companion;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.DisplayCutout;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityManager;

import java.util.ArrayList;
import java.util.List;

/**
 * Owns the overlay unit: the companion between two ribbons.
 *
 * The unit replaces the voice card. A card had a background so it occluded, it
 * wrapped so it reflowed, and it stacked so it grew until it buried the
 * persistent transcript line. A ribbon is one line in a viewport that content
 * never resizes.
 *
 * On Android the unit's companion and ribbons share one bounded WindowManager
 * root. Every resting position derives from the companion anchor, and a
 * deliberate drag moves that root once per display frame without detaching
 * gesture views or losing incoming content.
 *
 * {@link OverlayService} keeps the voice session, the composer, and the
 * companion's own gestures; it drives this class with the current turn's text
 * and asks it nothing about how that text is painted.
 */
final class MoaOverlayUnitController {

    interface Host {
        Context context();

        WindowManager windowManager();

        MoaCompactOverlayRoot compactRoot();

        int overlayType();

        View companion();

        WindowManager.LayoutParams companionParams();

        int companionSizePx();

        /** A drag began on a ribbon. The companion is still the anchor. */
        void onDragStart();

        void onDragMove(int dx, int dy);

        void onDragEnd(boolean committed);

        /** The History button: a separate surface, never a scrollback here. */
        void openHistory();

        void hideOverlay();

        boolean assistantSpeaking();

        boolean retryAvailable();

        void stopSpeaking();

        void retryCapture();

        /** Return true when Copy will finalize capture before copying. */
        boolean finalizeUserTranscriptForCopy();

        /** Both ribbons finished lingering; nothing is left to show. */
        void onWentDormant();
    }

    private final Host host;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final MoaRibbonBuffer youBuffer = new MoaRibbonBuffer();
    private final MoaRibbonBuffer replyBuffer = new MoaRibbonBuffer();
    private final MoaRibbonPresence youPresence = new MoaRibbonPresence();
    private final MoaRibbonPresence replyPresence = new MoaRibbonPresence();
    private final MoaTranscriptVariants youVariants = new MoaTranscriptVariants();

    private MoaRibbonView youView;
    private MoaRibbonView replyView;
    private WindowManager.LayoutParams youParams;
    private WindowManager.LayoutParams replyParams;
    private MoaRibbonTouchListener youTouch;
    private MoaRibbonTouchListener replyTouch;
    private View menuView;
    private Runnable pendingPresenceTick;
    private Runnable pendingMenuIdleDismiss;
    private int toneColor;
    private final MoaWindowLayoutState youLayoutState = new MoaWindowLayoutState();
    private final MoaWindowLayoutState replyLayoutState = new MoaWindowLayoutState();
    private boolean dragMode;

    MoaOverlayUnitController(Host host) {
        this.host = host;
    }

    boolean isShowing() {
        return youView != null;
    }

    // --- Lifecycle --------------------------------------------------------

    void show() {
        if (youView != null || host.companion() == null || host.companionParams() == null) {
            return;
        }
        Context context = host.context();
        youView = new MoaRibbonView(context, false);
        replyView = new MoaRibbonView(context, true);
        MoaRibbonTokens.Palette palette = palette();
        boolean highContrast = highTextContrast();
        for (MoaRibbonView ribbon : new MoaRibbonView[]{youView, replyView}) {
            ribbon.setPalette(palette);
            ribbon.setHighContrast(highContrast);
        }

        int width = ribbonWidthPx();
        youView.setContentWidth(width);
        replyView.setContentWidth(width);
        youParams = windowParams(width, youView.ribbonHeightPx());
        replyParams = windowParams(width, replyView.ribbonHeightPx());
        youTouch = attachGestures(youView, youPresence, youVariants, youBuffer, false);
        replyTouch = attachGestures(replyView, replyPresence, null, replyBuffer, true);

        youLayoutState.reset();
        replyLayoutState.reset();
        position();
        applyPresence();
    }

    /** Animated dismissal: the unit softens away rather than blinking out. */
    void hide() {
        closeMenu();
        if (youView == null && replyView == null) {
            return;
        }
        clearBuffers();
        MoaRibbonView you = youView;
        MoaRibbonView reply = replyView;
        detachState();
        fadeOut(you);
        fadeOut(reply);
    }

    /** Immediate teardown in one frame: drag-to-remove and service destroy. */
    void detachNow() {
        closeMenu();
        MoaRibbonView you = youView;
        MoaRibbonView reply = replyView;
        clearBuffers();
        detachState();
        detach(you);
        detach(reply);
    }

    private void clearBuffers() {
        youBuffer.clear();
        replyBuffer.clear();
        youVariants.clear();
        for (MoaRibbonPresence presence : new MoaRibbonPresence[]{youPresence, replyPresence}) {
            presence.setHasText(false);
            presence.setStreaming(false);
            presence.setExpanded(false);
            presence.releaseLatch();
        }
    }

    private void fadeOut(final MoaRibbonView ribbon) {
        if (ribbon == null) {
            return;
        }
        ribbon.setCaretVisible(false);
        ribbon.setListening(false);
        ribbon.animate()
                .alpha(0f)
                .setDuration(MoaRibbonTokens.DUR_SLOW_MS)
                .withEndAction(() -> detach(ribbon))
                .start();
    }

    private void detach(MoaRibbonView ribbon) {
        if (ribbon == null) {
            return;
        }
        ribbon.release();
        host.compactRoot().removeSlot(ribbon);
    }

    private void detachState() {
        cancel(pendingPresenceTick);
        pendingPresenceTick = null;
        if (youTouch != null) {
            youTouch.release();
            youTouch = null;
        }
        if (replyTouch != null) {
            replyTouch.release();
            replyTouch = null;
        }
        youView = null;
        replyView = null;
        youParams = null;
        replyParams = null;
        View companion = host.companion();
        if (companion != null) {
            companion.setAlpha(MoaRibbonTokens.COMPANION_DORMANT_ALPHA);
            companion.setScaleX(1f);
            companion.setScaleY(1f);
        }
    }

    // --- Content ----------------------------------------------------------

    /**
     * Push the current turn. Both texts are the accumulated turn text, not
     * deltas: the buffer owns retention and the grapheme-safe tail window, and
     * only the line's translation moves inside the fixed viewport.
     */
    void render(String youText, String replyText, boolean listening, boolean answering, int tone) {
        render(youText, replyText, replyText, listening, answering, false, false, -1, tone);
    }

    void render(String youText, String replyText, String replyFullText,
            boolean listening, boolean answering, boolean youPlaceholder,
            boolean replyPlaceholder, int youHighlightStart, int tone) {
        if (youView == null || replyView == null) {
            return;
        }
        toneColor = tone;
        // The literal transcript is what the provider produced. Corrected and
        // polished variants are derived text and are never written here.
        youVariants.setLiteral(flatten(youText));
        push(youView, youBuffer, youPresence, youVariants.defaultText());
        // The retained buffer (Copy and expansion) always owns the COMPLETE
        // reply. The collapsed spoken window is a paint-time override that only
        // reveals text the AudioTrack playback head has crossed; it never
        // becomes the retained text, so Copy cannot take a half-spoken reply.
        String replyFull = flatten(replyFullText);
        String replyCollapsed = flatten(replyText);
        push(replyView, replyBuffer, replyPresence, replyFull);
        replyView.setCollapsedSpoken(replyCollapsed, !replyCollapsed.equals(replyFull));
        youView.setHighlightStart(youHighlightStart);

        youView.setListening(listening);
        youView.setCaretVisible(listening);
        replyView.setCaretVisible(answering);
        youPresence.setHasText(youPlaceholder || !youBuffer.isEmpty());
        replyPresence.setHasText(replyPlaceholder || !replyBuffer.isEmpty());
        youPresence.setStreaming(listening);
        replyPresence.setStreaming(answering);
        replyView.setTone(toneColor);
        applyPresence();
    }

    /** Corrected and polished forms of the current turn, when a producer exists. */
    void setDerivedTranscripts(String corrected, String polished) {
        youVariants.setCorrected(corrected);
        youVariants.setPolished(polished);
        if (youView != null) {
            push(youView, youBuffer, youPresence, youVariants.defaultText());
            applyPresence();
        }
    }

    private void push(
            MoaRibbonView ribbon, MoaRibbonBuffer buffer, MoaRibbonPresence presence, String text) {
        if (text.isEmpty()) {
            buffer.clear();
        } else {
            buffer.replace(text);
        }
        ribbon.setWindowText(buffer.window());
        ribbon.setFullText(buffer.text());
        presence.setHasText(!buffer.isEmpty());
    }

    /** Bubbles wrap inside fixed viewports, so newlines survive; blank runs collapse. */
    private static String flatten(String text) {
        String value = text == null ? "" : text.trim();
        if (value.isEmpty()) {
            return "";
        }
        return value.replaceAll("[ \\t]*\\n+[ \\t]*", "\n").replaceAll("[ \\t]{2,}", " ").trim();
    }

    /** The turn ended: freeze the buffers and start each ribbon's linger. */
    void startLinger(boolean replyMustBeRead) {
        long now = SystemClock.uptimeMillis();
        youPresence.setStreaming(false);
        replyPresence.setStreaming(false);
        youPresence.startLinger(now, MoaRibbonPresence.lingerFor(false, false));
        replyPresence.startLinger(now, MoaRibbonPresence.lingerFor(true, replyMustBeRead));
        applyPresence();
    }

    // --- Geometry ---------------------------------------------------------

    void position() {
        position(true);
    }

    void preparePosition() {
        position(false);
    }

    private void position(boolean commit) {
        if (dragMode) {
            return;
        }
        WindowManager.LayoutParams companionParams = host.companionParams();
        if (youView == null || replyView == null || companionParams == null) {
            return;
        }
        Context context = host.context();
        int screenWidth = context.getResources().getDisplayMetrics().widthPixels;
        int screenHeight = context.getResources().getDisplayMetrics().heightPixels;
        youParams.height = youView.desiredHeightPx();
        replyParams.height = replyView.desiredHeightPx();
        MoaRibbonUnitLayout.Placement placement = MoaRibbonUnitLayout.place(
                screenWidth,
                screenHeight,
                dp(MoaRibbonTokens.EDGE_MARGIN_DP),
                dp(MoaRibbonTokens.GAP_DP),
                insetTop(),
                insetBottom(),
                companionParams.x,
                companionParams.y,
                host.companionSizePx(),
                youParams.width,
                youParams.height,
                replyParams.height);
        youParams.x = placement.youX;
        youParams.y = placement.youY;
        replyParams.x = placement.replyX;
        replyParams.y = placement.replyY;
        boolean changed = updateLayoutIfChanged(youView, youParams, youLayoutState);
        changed |= updateLayoutIfChanged(replyView, replyParams, replyLayoutState);
        if (commit && changed) host.compactRoot().commitFrame();
    }

    void onConfigurationChanged() {
        // Rotation and resize are the only moments the flip test may re-run
        // outside a drag; it must never re-run mid-stream.
        closeMenu();
        position();
        applyPresence();
    }

    private int ribbonWidthPx() {
        int screenWidth = host.context().getResources().getDisplayMetrics().widthPixels;
        return Math.min(
                screenWidth - dp(MoaRibbonTokens.EDGE_MARGIN_DP) * 2,
                dp(MoaRibbonTokens.RIBBON_MAX_W_DP));
    }

    private WindowManager.LayoutParams windowParams(int width, int height) {
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                width, height, host.overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        // Ribbons are never editable, so the IME must not move
                        // them. Only the composer reacts to the keyboard.
                        | WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING;
        return params;
    }

    // The typed inset API arrived in API 30 and this app ships to API 26, so both
    // accessors branch inline rather than behind a helper: lint cannot see through
    // a helper's version guard, and a suppression or a baseline would have kept
    // the defect while hiding the report. The pre-30 fallback has to be a real
    // answer, not zero — zero would put the ribbons under the status bar and
    // behind the navigation bar on Android 8 through 10.
    //
    // The modern top asks for the cutout as well as the status bar, so the legacy
    // top has to too. It matters here: the companion window is
    // FLAG_LAYOUT_NO_LIMITS, so it can extend into a notch, and on API 28-29 the
    // system window inset alone can under-report that. See MoaWindowInsetPolicy.
    private int insetTop() {
        WindowInsets insets = rootInsets();
        if (insets == null) {
            return 0;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return insets.getInsets(
                    WindowInsets.Type.statusBars() | WindowInsets.Type.displayCutout()).top;
        }
        return MoaWindowInsetPolicy.legacyTop(legacySystemTop(insets), legacyCutoutTop(insets));
    }

    private int insetBottom() {
        WindowInsets insets = rootInsets();
        if (insets == null) {
            return 0;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
        }
        return MoaWindowInsetPolicy.legacyBottom(legacySystemBottom(insets));
    }

    @SuppressWarnings("deprecation")
    private static int legacySystemTop(WindowInsets insets) {
        return insets.getSystemWindowInsetTop();
    }

    @SuppressWarnings("deprecation")
    private static int legacySystemBottom(WindowInsets insets) {
        return insets.getSystemWindowInsetBottom();
    }

    private static int legacyCutoutTop(WindowInsets insets) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            // No cutout API, and no device with a cutout, below API 28.
            return 0;
        }
        DisplayCutout cutout = insets.getDisplayCutout();
        return cutout == null ? 0 : cutout.getSafeInsetTop();
    }

    private WindowInsets rootInsets() {
        View companion = host.companion();
        if (companion == null) {
            return null;
        }
        return companion.getRootWindowInsets();
    }

    // --- Presence ---------------------------------------------------------

    /**
     * One choke point for "how solid is the unit right now". Everything that can
     * change the answer — a press, a latch, an expansion, a linger expiring, a
     * stream starting — ends here, and here is the only place that writes opacity.
     */
    void applyPresence() {
        long now = SystemClock.uptimeMillis();
        MoaRibbonPresence.State you = youPresence.state(now);
        MoaRibbonPresence.State reply = replyPresence.state(now);
        MoaRibbonTokens.Palette palette = palette();
        if (youView != null) {
            youView.setPalette(palette);
            youView.setExpanded(youPresence.expanded());
            youView.setPresenceState(you);
        }
        if (replyView != null) {
            replyView.setPalette(palette);
            replyView.setExpanded(replyPresence.expanded());
            replyView.setPresenceState(reply);
        }
        applyTouchability(youView, youParams,
                MoaRibbonPresence.acceptsTouch(you, !youBuffer.isEmpty()));
        applyTouchability(replyView, replyParams,
                MoaRibbonPresence.acceptsTouch(reply, !replyBuffer.isEmpty()));
        View companion = host.companion();
        if (companion != null) {
            MoaRibbonPresence.State unit = you.ordinal() > reply.ordinal() ? you : reply;
            // The companion's touch listener also fades it for press feedback;
            // the presence machine is the authority, so cancel that first.
            companion.animate().cancel();
            companion.setAlpha(MoaRibbonPresence.companionAlpha(unit));
            float scale = unit == MoaRibbonPresence.State.DRAGGING
                    ? MoaRibbonTokens.COMPANION_DRAG_SCALE : 1f;
            companion.setScaleX(scale);
            companion.setScaleY(scale);
        }
        if (!dragMode) {
            position();
        }
        schedulePresenceTick(now);
    }

    /**
     * A ribbon with no text takes no touch AT ALL: the window is flagged
     * NOT_TOUCHABLE so a tap lands in the app underneath. With text, the window
     * is touchable and MoaRibbonView rejects anything off the painted glyph run.
     */
    private void applyTouchability(
            MoaRibbonView ribbon, WindowManager.LayoutParams params, boolean touchable) {
        if (ribbon == null || params == null) {
            return;
        }
        int flags = touchable
                ? params.flags & ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                : params.flags | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        if (flags == params.flags) {
            return;
        }
        params.flags = flags;
        // position() owns the single layout submission after geometry or flags
        // change. Paint-only stream deltas never cross into WindowManager.
    }

    private boolean updateLayoutIfChanged(
            MoaRibbonView ribbon,
            WindowManager.LayoutParams params,
            MoaWindowLayoutState state) {
        if (ribbon != null && params != null && state.changed(params)) {
            host.compactRoot().put(ribbon,
                    new Rect(params.x, params.y, params.x + params.width, params.y + params.height),
                    (params.flags & WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE) == 0);
            return true;
        }
        return false;
    }

    // Latch and linger are deadlines, not events, so the unit re-evaluates itself
    // once when the nearest deadline falls due instead of polling.
    private void schedulePresenceTick(long now) {
        cancel(pendingPresenceTick);
        pendingPresenceTick = null;
        long next = Math.min(deadline(youPresence, now), deadline(replyPresence, now));
        if (next == Long.MAX_VALUE) {
            return;
        }
        pendingPresenceTick = () -> {
            pendingPresenceTick = null;
            applyPresence();
            long tickNow = SystemClock.uptimeMillis();
            if (youPresence.state(tickNow) == MoaRibbonPresence.State.DORMANT
                    && replyPresence.state(tickNow) == MoaRibbonPresence.State.DORMANT) {
                host.onWentDormant();
            }
        };
        mainHandler.postDelayed(pendingPresenceTick, Math.max(16, next - now));
    }

    private static long deadline(MoaRibbonPresence presence, long now) {
        long soonest = Long.MAX_VALUE;
        if (presence.latched(now)) {
            soonest = Math.min(soonest, now + MoaRibbonTokens.DUR_LATCH_MS);
        }
        if (presence.lingerDeadlineMs() > now) {
            soonest = Math.min(soonest, presence.lingerDeadlineMs());
        }
        return soonest;
    }

    void setDragging(boolean dragging) {
        if (dragMode == dragging) {
            return;
        }
        dragMode = dragging;
        if (dragging) {
            closeMenu();
        }
        youPresence.setDragging(dragging);
        replyPresence.setDragging(dragging);
        if (!dragging) {
            youPresence.setPointerDown(false);
            replyPresence.setPointerDown(false);
        }
        if (!dragging) {
            if (youView != null) {
                youView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
            }
            if (replyView != null) {
                replyView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
            }
        }
        applyPresence();
    }

    // --- Gestures ---------------------------------------------------------

    // Every element of the unit is a drag handle, and the anchor is always the
    // companion. A ribbon remains attached through ACTION_UP while the bounded
    // root moves as one window.
    private MoaRibbonTouchListener attachGestures(
            final MoaRibbonView ribbon,
            final MoaRibbonPresence presence,
            final MoaTranscriptVariants variants,
            final MoaRibbonBuffer buffer,
            final boolean reply) {
        MoaRibbonTouchListener.Callbacks callbacks = new MoaRibbonTouchListener.Callbacks() {
            @Override
            public void onPressChanged(boolean down) {
                presence.setPointerDown(down);
                applyPresence();
            }

            @Override
            public void onTap() {
                // Tap opens the bounded bubble to its full scrollable text;
                // tapping again closes it. Copy and History are their own
                // buttons, never a tap consequence.
                boolean opening = !presence.expanded();
                presence.setExpanded(opening);
                if (opening) {
                    presence.latch(SystemClock.uptimeMillis());
                } else {
                    presence.releaseLatch();
                }
                applyPresence();
            }

            @Override
            public void onCopy() {
                ribbon.flash();
                if (!reply && host.finalizeUserTranscriptForCopy()) {
                    return;
                }
                copy(variants, buffer, null);
            }

            @Override
            public void onHistory() {
                ribbon.flash();
                host.openHistory();
            }

            @Override
            public void onHold() {
                // Only the reply side has a menu, and it carries no Copy row:
                // the visible Copy button is the one copy affordance. The
                // you-bubble's actions are all on its rails already.
                if (reply) {
                    openMenu(ribbon, presence, buffer);
                }
            }

            @Override
            public void onDragStart() {
                host.onDragStart();
                setDragging(true);
            }

            @Override
            public void onDragMove(int dx, int dy) {
                host.onDragMove(dx, dy);
            }

            @Override
            public void onDragEnd(boolean committed) {
                presence.setPointerDown(false);
                host.onDragEnd(committed);
            }
        };
        MoaRibbonTouchListener listener = new MoaRibbonTouchListener(
                host.context(), ribbon, callbacks);
        ribbon.setOnTouchListener(listener);
        ribbon.setAccessibilityActions(
                callbacks::onTap, callbacks::onCopy, callbacks::onHistory);
        return listener;
    }

    // --- Copy and menu ----------------------------------------------------

    /**
     * Copy always takes the FULL retained buffer, never the visible window. When
     * derived variants exist, a plain copy takes the polished one; a named
     * variant takes exactly that one and leaves the literal transcript untouched.
     */
    private void copy(
            MoaTranscriptVariants variants,
            MoaRibbonBuffer buffer,
            MoaTranscriptVariants.Variant variant) {
        ClipboardManager clipboard =
                (ClipboardManager) host.context().getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) {
            return;
        }
        String value = variants == null
                ? buffer.text()
                : (variant == null ? variants.defaultText() : variants.text(variant));
        if (value.isEmpty()) {
            return;
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("Ag voice transcript", value));
        // Android 13+ shows its own copy confirmation; a second one would be
        // noise. The announcement exists so a truncated copy is still honest.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU && youView != null) {
            youView.announceForAccessibility(buffer.copyAnnouncement());
        }
    }

    /** Complete a deferred user-copy request after the final transcript renders. */
    void copyUserTranscript() {
        copy(youVariants, youBuffer, null);
    }

    private void openMenu(
            MoaRibbonView ribbon, MoaRibbonPresence presence, MoaRibbonBuffer buffer) {
        closeMenu();
        WindowManager.LayoutParams params = replyParams;
        if (params == null || buffer.isEmpty()) {
            return;
        }
        presence.setMenuOpen(true);
        applyPresence();
        menuView = MoaRibbonMenu.show(
                host.context(), host.windowManager(), host.overlayType(), palette(),
                replyRows(),
                params.x, params.y, ribbon.ribbonHeightPx(), this::closeMenu);
        pendingMenuIdleDismiss = this::closeMenu;
        mainHandler.postDelayed(pendingMenuIdleDismiss, MoaRibbonTokens.MENU_IDLE_DISMISS_MS);
    }

    /**
     * The reply menu carries only playback and surface utilities. Copy lives on
     * the visible rail and NOWHERE else, so there is exactly one copy behavior.
     */
    private List<MoaRibbonMenu.Row> replyRows() {
        List<MoaRibbonMenu.Row> rows = new ArrayList<>();
        if (host.assistantSpeaking()) {
            rows.add(MoaRibbonMenu.Row.of("Stop speaking", host::stopSpeaking));
        } else if (host.retryAvailable()) {
            // The card's "Record again" affordance. A failed turn has no audio to
            // replay, so the retry takes that row.
            rows.add(MoaRibbonMenu.Row.of("Record again", host::retryCapture));
        } else {
            rows.add(MoaRibbonMenu.Row.disabled("Replay"));
        }
        rows.add(MoaRibbonMenu.Row.of("Open history", host::openHistory));
        rows.add(MoaRibbonMenu.Row.of("Hide overlay", host::hideOverlay));
        return rows;
    }

    void closeMenu() {
        cancel(pendingMenuIdleDismiss);
        pendingMenuIdleDismiss = null;
        View menu = menuView;
        menuView = null;
        youPresence.setMenuOpen(false);
        replyPresence.setMenuOpen(false);
        if (menu != null) {
            MoaOverlayWindowLayout.detach(host.windowManager(), menu);
            applyPresence();
        }
    }

    // --- Theme ------------------------------------------------------------

    private MoaRibbonTokens.Palette palette() {
        int mode = host.context().getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK;
        // Android cannot see the app underneath and must not try; sampling the
        // screen for a cosmetic decision would be a screen capture.
        return MoaRibbonTokens.palette(mode == Configuration.UI_MODE_NIGHT_NO);
    }

    private boolean highTextContrast() {
        AccessibilityManager manager = (AccessibilityManager)
                host.context().getSystemService(Context.ACCESSIBILITY_SERVICE);
        if (manager == null) {
            return false;
        }
        try {
            return manager.isEnabled() && (boolean) AccessibilityManager.class
                    .getMethod("isHighTextContrastEnabled").invoke(manager);
        } catch (Exception ignored) {
            return false;
        }
    }

    private void cancel(Runnable runnable) {
        if (runnable != null) {
            mainHandler.removeCallbacks(runnable);
        }
    }

    private int dp(int value) {
        return Math.round(value * host.context().getResources().getDisplayMetrics().density);
    }
}
