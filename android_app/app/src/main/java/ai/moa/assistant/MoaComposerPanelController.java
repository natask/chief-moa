package ai.moa.assistant;

import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

/**
 * Owns the composer panel: the typed-chat surface.
 *
 * The panel is deliberately NOT part of the overlay unit. The unit is the
 * companion between two ribbons and shows the current turn only; the panel is a
 * separate window with a scrollback, a header, context pills and a text field,
 * and it opens on its own gesture. Keeping the two in one class only ever made
 * {@link OverlayService} longer.
 *
 * The service keeps everything that depends on the companion's position — the
 * anchoring rule, the remeasure hook, the header drag — and hands them in
 * through {@link Host}. Everything that is purely the panel's own construction,
 * state and teardown lives here.
 */
final class MoaComposerPanelController {

    interface Host {
        Context context();

        WindowManager windowManager();

        int overlayType();

        /** Anchor the panel above the companion. Owned by the service. */
        void positionNearCompanion(View surface, WindowManager.LayoutParams params);

        /** Re-anchor when the panel remeasures. Owned by the service. */
        void keepAnchoredOnRemeasure(View surface);

        /** The header is a drag handle for the whole overlay group. */
        void attachHeaderDrag(View header);

        /** A press outside the panel closes the overlay UI. */
        void onOutsideTouch();

        void onHideOverlay();

        void onClosePanel();

        void onSend(String text);

        void onToggleRecordMode();

        boolean recordModeEnabled();

        MoaContextControlState contextControls();

        void onContextControlsChanged();

        String headerStatusText();

        String gestureHint();

        List<ChatMessage> messages();
    }

    private final Host host;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private View panelView;
    private WindowManager.LayoutParams panelParams;
    private boolean panelOpen;
    private LinearLayout messageColumn;
    private ScrollView messageScroll;
    private EditText composer;
    private TextView runStatusView;
    private TextView recordModePill;
    private TextView newThreadPill;
    private TextView incognitoPill;
    private LinearLayout contextControlsRow;

    MoaComposerPanelController(Host host) {
        this.host = host;
    }

    boolean isOpen() {
        return panelOpen;
    }

    View view() {
        return panelView;
    }

    WindowManager.LayoutParams params() {
        return panelParams;
    }

    void toggle() {
        if (panelOpen) {
            remove();
        } else {
            show();
        }
    }

    void show() {
        if (panelView != null) {
            return;
        }
        Context context = host.context();
        panelView = createPanel();
        int width = MoaComposerPanelMetrics.panelWidth(
                context.getResources().getDisplayMetrics().widthPixels,
                context.getResources().getDisplayMetrics().density);
        panelParams = new WindowManager.LayoutParams(
                width,
                WindowManager.LayoutParams.WRAP_CONTENT,
                host.overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
        );
        // The surface follows the orb and stays wholly above it; when there is
        // not enough room the ORB is pushed down, never the card below. The IME
        // does not resize overlay windows, so positioning is kept independent
        // from keyboard animation.
        panelParams.gravity = Gravity.TOP | Gravity.START;
        panelParams.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING;
        panelView.setOnTouchListener((view, event) -> {
            if (event.getActionMasked() == MotionEvent.ACTION_OUTSIDE) {
                host.onOutsideTouch();
                return true;
            }
            return false;
        });
        host.positionNearCompanion(panelView, panelParams);
        host.keepAnchoredOnRemeasure(panelView);
        host.windowManager().addView(panelView, panelParams);
        panelOpen = true;
        panelView.post(() -> host.positionNearCompanion(panelView, panelParams));
        renderMessages();
        MoaOverlayWindowLayout.animateIn(panelView, dp(18));
        mainHandler.postDelayed(() -> {
            if (composer == null) {
                return;
            }
            composer.requestFocus();
            InputMethodManager inputMethodManager = inputMethodManager();
            if (inputMethodManager != null) {
                inputMethodManager.showSoftInput(composer, InputMethodManager.SHOW_IMPLICIT);
            }
        }, 180);
    }

    void remove() {
        if (panelView == null) {
            return;
        }
        hideKeyboard();
        final View dying = panelView;
        clearState();
        dying.animate()
                .alpha(0f)
                .translationY(dp(14))
                .scaleX(0.97f)
                .scaleY(0.97f)
                .setDuration(130)
                .setInterpolator(new android.view.animation.AccelerateInterpolator())
                .withEndAction(() -> MoaOverlayWindowLayout.detach(host.windowManager(), dying))
                .start();
    }

    /** Teardown with no exit animation, for drag-to-remove and service destroy. */
    void detachNow() {
        View dying = panelView;
        clearState();
        MoaOverlayWindowLayout.detach(host.windowManager(), dying);
    }

    private void clearState() {
        panelView = null;
        panelParams = null;
        panelOpen = false;
        messageColumn = null;
        messageScroll = null;
        composer = null;
        runStatusView = null;
        recordModePill = null;
        newThreadPill = null;
        incognitoPill = null;
        contextControlsRow = null;
    }

    void hideKeyboard() {
        InputMethodManager inputMethodManager = inputMethodManager();
        if (inputMethodManager != null && composer != null) {
            inputMethodManager.hideSoftInputFromWindow(composer.getWindowToken(), 0);
        }
    }

    /** Hidden while the overlay group is being dragged, then restored. */
    void setHidden(boolean hidden) {
        if (panelView == null) {
            return;
        }
        panelView.animate().cancel();
        panelView.setAlpha(hidden ? 0f : 1f);
        panelView.setImportantForAccessibility(hidden
                ? View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                : View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
    }

    void setComposerText(String text) {
        if (composer == null) {
            return;
        }
        composer.setText(text);
        composer.setSelection(composer.getText().length());
    }

    void setHeaderStatus(String status) {
        if (runStatusView != null) {
            runStatusView.setText(status);
        }
    }

    // --- Construction -----------------------------------------------------

    private View createPanel() {
        Context context = host.context();
        FrameLayout shell = new FrameLayout(context);
        shell.setBackground(MoaDrawables.roundedGradient(
                MoaColors.RAISED, MoaColors.PANEL_BG, dp(26), MoaColors.PANEL_BORDER, dp(1)));
        shell.setElevation(dp(28));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            shell.setOutlineSpotShadowColor(0xFF000000);
            shell.setOutlineAmbientShadowColor(0xFF000000);
        }
        shell.setClipToOutline(true);
        shell.setOutlineProvider(new android.view.ViewOutlineProvider() {
            @Override
            public void getOutline(View view, android.graphics.Outline outline) {
                outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), dp(26));
            }
        });
        LinearLayout panel = new LinearLayout(context);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(16), dp(15), dp(16), dp(15));
        shell.addView(panel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        panel.addView(createHeader());
        panel.addView(createContextControlsRow());
        messageScroll = new ScrollView(context);
        messageScroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
        messageScroll.setVerticalScrollBarEnabled(false);
        messageScroll.setClipToPadding(false);
        messageScroll.setPadding(0, dp(2), 0, dp(2));
        messageColumn = new LinearLayout(context);
        messageColumn.setOrientation(LinearLayout.VERTICAL);
        messageScroll.addView(messageColumn, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        LinearLayout.LayoutParams scrollParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(260)
        );
        scrollParams.topMargin = dp(10);
        panel.addView(messageScroll, scrollParams);
        panel.addView(createComposer());
        return shell;
    }

    private View createHeader() {
        Context context = host.context();
        LinearLayout header = new LinearLayout(context);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setPadding(0, 0, 0, dp(4));
        PulseDot dot = new PulseDot(context);
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(10), dp(10));
        dotParams.rightMargin = dp(10);
        dotParams.gravity = Gravity.CENTER_VERTICAL;
        header.addView(dot, dotParams);
        LinearLayout copy = new LinearLayout(context);
        copy.setOrientation(LinearLayout.VERTICAL);
        TextView label = text("AG", MoaColors.PAPER, 17, true);
        label.setLetterSpacing(0.02f);
        copy.addView(label);
        runStatusView = text(host.headerStatusText(), MoaColors.MUTED, 11, false);
        copy.addView(runStatusView);
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        recordModePill = pill("Record", 0x16FFFFFF, MoaColors.MUTED);
        recordModePill.setOnClickListener(v -> host.onToggleRecordMode());
        refreshRecordModePill();
        header.addView(recordModePill);
        TextView hide = pill("Hide", 0x16FF453A, 0xFFFFAAA4);
        hide.setContentDescription("Hide the AG orb");
        hide.setOnClickListener(v -> host.onHideOverlay());
        header.addView(hide);
        TextView close = pill("×", 0x16FFFFFF, MoaColors.MUTED);
        close.setContentDescription("Close chat");
        close.setOnClickListener(v -> host.onClosePanel());
        header.addView(close);
        host.attachHeaderDrag(header);
        return header;
    }

    private View createContextControlsRow() {
        Context context = host.context();
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(6), dp(5), dp(6), dp(5));
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        rowParams.topMargin = dp(8);
        row.setLayoutParams(rowParams);
        contextControlsRow = row;
        newThreadPill = pill("New thread", 0x16FFFFFF, MoaColors.MUTED);
        newThreadPill.setOnClickListener(v -> {
            host.contextControls().toggleNewThread();
            host.onContextControlsChanged();
        });
        row.addView(newThreadPill);
        incognitoPill = pill("Incognito", 0x16FFFFFF, MoaColors.MUTED);
        incognitoPill.setOnClickListener(v -> {
            host.contextControls().toggleIncognito();
            host.onContextControlsChanged();
        });
        row.addView(incognitoPill);
        // Flexible spacer keeps the pills left-aligned; the row tint fills behind.
        row.addView(new View(context), new LinearLayout.LayoutParams(0, dp(1), 1f));
        refreshContextControls();
        return row;
    }

    private View createComposer() {
        Context context = host.context();
        LinearLayout row = new LinearLayout(context);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(dp(6), dp(6), dp(6), dp(6));
        row.setBackground(MoaDrawables.rounded(
                MoaColors.COMPOSER_BG, dp(26), MoaColors.COMPOSER_BORDER, dp(1)));
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        rowParams.topMargin = dp(12);
        row.setLayoutParams(rowParams);
        composer = new EditText(context);
        composer.setHint("Message AG");
        composer.setHintTextColor(MoaColors.MUTED);
        composer.setTextColor(MoaColors.PAPER);
        composer.setTextSize(15);
        composer.setMinLines(1);
        composer.setMaxLines(4);
        composer.setInputType(InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        composer.setSingleLine(false);
        composer.setBackgroundColor(Color.TRANSPARENT);
        composer.setPadding(dp(12), dp(9), dp(8), dp(9));
        row.addView(composer, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        // Round gold send button. 46dp target, gold brand accent.
        TextView send = new TextView(context);
        send.setText("↑");
        send.setTextColor(MoaColors.INK);
        send.setTextSize(20);
        send.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        send.setGravity(Gravity.CENTER);
        send.setBackground(MoaDrawables.circle(MoaColors.GOLD, 0x33FFFFFF, dp(1)));
        LinearLayout.LayoutParams sendParams = new LinearLayout.LayoutParams(dp(46), dp(46));
        sendParams.leftMargin = dp(4);
        send.setLayoutParams(sendParams);
        send.setOnClickListener(v -> sendComposer());
        row.addView(send);
        return row;
    }

    private void sendComposer() {
        if (composer == null) {
            return;
        }
        String value = composer.getText().toString().trim();
        if (value.isEmpty()) {
            return;
        }
        composer.setText("");
        host.onSend(value);
    }

    // --- Refresh ----------------------------------------------------------

    void renderMessages() {
        if (messageColumn == null) {
            return;
        }
        messageColumn.removeAllViews();
        List<ChatMessage> messages = host.messages();
        if (messages.isEmpty()) {
            TextView empty = text(host.gestureHint(), MoaColors.MUTED, 13, false);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(dp(8), dp(28), dp(8), dp(28));
            messageColumn.addView(empty);
            return;
        }
        for (ChatMessage message : messages) {
            messageColumn.addView(messageBubble(message));
        }
        if (messageScroll != null) {
            mainHandler.postDelayed(() -> {
                if (messageScroll != null) {
                    messageScroll.fullScroll(View.FOCUS_DOWN);
                }
            }, 40);
        }
    }

    void refreshRecordModePill() {
        if (recordModePill == null) {
            return;
        }
        boolean on = host.recordModeEnabled();
        recordModePill.setText(on ? "Record on" : "Record");
        recordModePill.setTextColor(on ? MoaColors.INK : MoaColors.MUTED);
        recordModePill.setBackground(MoaDrawables.rounded(
                on ? MoaColors.GOLD : 0x16FFFFFF,
                dp(999),
                on ? 0x33FFFFFF : 0x10FFFFFF,
                dp(1)
        ));
    }

    void refreshContextControls() {
        MoaContextControlState controls = host.contextControls();
        if (newThreadPill != null) {
            boolean armed = controls.isNewThreadArmed();
            newThreadPill.setText(armed ? "New thread armed" : "New thread");
            newThreadPill.setTextColor(armed ? MoaColors.INK : MoaColors.MUTED);
            newThreadPill.setBackground(MoaDrawables.rounded(
                    armed ? MoaColors.GOLD : 0x16FFFFFF,
                    dp(999),
                    armed ? 0x33FFFFFF : 0x10FFFFFF,
                    dp(1)
            ));
        }
        if (incognitoPill != null) {
            boolean on = controls.isIncognitoEnabled();
            incognitoPill.setText(on ? "Incognito on" : "Incognito");
            incognitoPill.setTextColor(on ? MoaColors.INK : MoaColors.MUTED);
            incognitoPill.setBackground(MoaDrawables.rounded(
                    on ? MoaColors.EMBER : 0x16FFFFFF,
                    dp(999),
                    on ? 0x40FFFFFF : 0x10FFFFFF,
                    dp(1)
            ));
        }
        if (contextControlsRow != null) {
            // Persistent tinted status row while incognito is on.
            contextControlsRow.setBackground(controls.isIncognitoEnabled()
                    ? MoaDrawables.rounded(0x22FF8A3D, dp(14), 0x40FF8A3D, dp(1))
                    : null);
        }
    }

    private View messageBubble(ChatMessage message) {
        Context context = host.context();
        LinearLayout wrap = new LinearLayout(context);
        wrap.setOrientation(LinearLayout.VERTICAL);
        TextView label = text(
                message.assistant ? "AG" : "You",
                message.assistant ? MoaColors.GOLD : 0xFFBFA9FF, 10, true);
        label.setLetterSpacing(0.08f);
        label.setPadding(dp(4), 0, dp(4), dp(3));
        LinearLayout bubble = new LinearLayout(context);
        bubble.setOrientation(LinearLayout.VERTICAL);
        bubble.setPadding(dp(14), dp(11), dp(14), dp(11));
        int r = dp(20);
        int tuck = dp(6);
        float[] radii = message.assistant
                // tl, tr, br, bl  -> tuck bottom-left
                ? new float[]{r, r, r, r, r, r, tuck, tuck}
                // tuck bottom-right
                : new float[]{r, r, r, r, tuck, tuck, r, r};
        int fill = message.assistant ? MoaColors.RAISED : MoaColors.USER_BG;
        int stroke = message.assistant ? MoaColors.RAISED_BORDER : MoaColors.USER_BORDER;
        bubble.setBackground(MoaDrawables.roundedCorners(fill, radii, stroke, dp(1)));
        // Cap the text width so a bubble never spans edge to edge (~80%).
        int maxBubbleText = MoaComposerPanelMetrics.bubbleMaxTextWidth(
                context.getResources().getDisplayMetrics().widthPixels,
                context.getResources().getDisplayMetrics().density);
        TextView body = text(message.text, MoaColors.PAPER, 15, false);
        body.setLineSpacing(dp(4), 1f);
        body.setMaxWidth(maxBubbleText);
        bubble.addView(body);
        wrap.addView(label);
        wrap.addView(bubble);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.gravity = message.assistant ? Gravity.START : Gravity.END;
        params.topMargin = dp(9);
        params.leftMargin = message.assistant ? 0 : dp(36);
        params.rightMargin = message.assistant ? dp(36) : 0;
        wrap.setLayoutParams(params);
        wrap.setGravity(message.assistant ? Gravity.START : Gravity.END);
        return wrap;
    }

    private InputMethodManager inputMethodManager() {
        return (InputMethodManager) host.context().getSystemService(Context.INPUT_METHOD_SERVICE);
    }

    private TextView pill(String value, int background, int foreground) {
        return MoaTextViews.pill(host.context(), value, background, foreground);
    }

    private TextView text(String value, int color, int sp, boolean bold) {
        return MoaTextViews.text(host.context(), value, color, sp, bold);
    }

    private int dp(int value) {
        return Math.round(value * host.context().getResources().getDisplayMetrics().density);
    }
}
