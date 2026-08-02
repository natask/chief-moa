package ag.companion;

import android.content.Context;
import android.graphics.Insets;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Build;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/** Owns exactly four bounded, non-touchable Minimal presentation windows. */
final class MoaMinimalRingController {
    private static final int THICKNESS_DP = 3;
    private static final int CORNER_GAP_DP = 10;

    private final Context context;
    private final WindowManager windowManager;
    private final int overlayType;
    private final Runnable openFullApp;
    private final List<MoaMinimalEdgeView> views = new ArrayList<>();
    private TextView fallback;
    private VoiceRuntimeState runtimeState = VoiceRuntimeState.READY;
    private boolean microphoneOpen;
    private float level;

    MoaMinimalRingController(Context context, WindowManager windowManager, int overlayType,
            Runnable openFullApp) {
        this.context = context;
        this.windowManager = windowManager;
        this.overlayType = overlayType;
        this.openFullApp = openFullApp;
    }

    boolean isShowing() { return !views.isEmpty(); }

    void show() {
        if (isShowing()) return;
        for (int index = 0; index < 4; index++) views.add(new MoaMinimalEdgeView(context));
        fallback = fallbackView();
        attachOrRelayout(true);
        render();
    }

    void detach() {
        for (MoaMinimalEdgeView view : views) {
            try { windowManager.removeView(view); } catch (IllegalArgumentException ignored) {}
        }
        views.clear();
        if (fallback != null) {
            try { windowManager.removeView(fallback); } catch (IllegalArgumentException ignored) {}
            fallback = null;
        }
    }

    void onConfigurationChanged() {
        if (isShowing()) attachOrRelayout(false);
    }

    void setRuntimeState(VoiceRuntimeState state) {
        runtimeState = state == null ? VoiceRuntimeState.READY : state;
        render();
    }

    void setMicrophoneOpen(boolean open) {
        microphoneOpen = open;
        if (!open) level = 0f;
        render();
    }

    void setInputLevel(float inputLevel) {
        if (!microphoneOpen) return;
        level = MoaMicrophoneLevel.smooth(level, inputLevel);
        render();
    }

    private void render() {
        MoaMinimalRingVisualState state = MoaMinimalRingVisualState.resolve(
                runtimeState, microphoneOpen, reducedMotion(), highContrast());
        for (MoaMinimalEdgeView view : views) view.render(state, level);
    }

    private void attachOrRelayout(boolean attach) {
        Frame frame = frame();
        List<MoaMinimalRingGeometry.Bounds> edges = MoaMinimalRingGeometry.edges(
                frame.width, frame.height, frame.left, frame.top, frame.right, frame.bottom,
                dp(THICKNESS_DP), dp(CORNER_GAP_DP));
        for (int index = 0; index < views.size(); index++) {
            MoaMinimalRingGeometry.Bounds edge = edges.get(index);
            WindowManager.LayoutParams params = params(edge);
            if (attach) windowManager.addView(views.get(index), params);
            else {
                try { windowManager.updateViewLayout(views.get(index), params); }
                catch (IllegalArgumentException ignored) {}
            }
        }
        WindowManager.LayoutParams fallbackParams = fallbackParams(frame);
        if (attach) windowManager.addView(fallback, fallbackParams);
        else {
            try { windowManager.updateViewLayout(fallback, fallbackParams); }
            catch (IllegalArgumentException ignored) {}
        }
    }

    private WindowManager.LayoutParams params(MoaMinimalRingGeometry.Bounds edge) {
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                Math.max(1, edge.width()), Math.max(1, edge.height()), overlayType,
                windowFlags(),
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = edge.left;
        params.y = edge.top;
        return params;
    }

    static int windowFlags() {
        return WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
    }

    static int fallbackWindowFlags() {
        return WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
    }

    private WindowManager.LayoutParams fallbackParams(Frame frame) {
        int size = dp(44);
        MoaMinimalRingGeometry.Bounds bounds = MoaMinimalRingGeometry.fallback(
                frame.width, frame.height, frame.left, frame.top, frame.right, frame.bottom,
                size, dp(12));
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                bounds.width(), bounds.height(), overlayType,
                fallbackWindowFlags(), PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = bounds.left;
        params.y = bounds.top;
        return params;
    }

    private TextView fallbackView() {
        TextView button = MoaTextViews.text(context, "Ag", MoaColors.INK, 13, true);
        button.setGravity(Gravity.CENTER);
        button.setBackground(MoaDrawables.circle(
                MoaColors.GOLD, 0x66FFFFFF, Math.max(1, dp(1))));
        button.setContentDescription("Open Ag full app");
        button.setClickable(true);
        button.setFocusable(true);
        button.setOnClickListener(view -> {
            if (openFullApp != null) openFullApp.run();
        });
        return button;
    }

    private Frame frame() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.view.WindowMetrics metrics = windowManager.getCurrentWindowMetrics();
            Rect bounds = metrics.getBounds();
            Insets insets = metrics.getWindowInsets().getInsetsIgnoringVisibility(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            return new Frame(bounds.width(), bounds.height(), insets.left, insets.top,
                    insets.right, insets.bottom);
        }
        DisplayMetrics metrics = new DisplayMetrics();
        windowManager.getDefaultDisplay().getRealMetrics(metrics);
        return new Frame(metrics.widthPixels, metrics.heightPixels, 0, statusBarHeight(), 0, 0);
    }

    private int statusBarHeight() {
        int id = context.getResources().getIdentifier("status_bar_height", "dimen", "android");
        return id == 0 ? 0 : context.getResources().getDimensionPixelSize(id);
    }

    private boolean reducedMotion() {
        try {
            return Settings.Global.getFloat(context.getContentResolver(),
                    Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f;
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean highContrast() {
        try {
            return Settings.Secure.getInt(context.getContentResolver(),
                    "high_text_contrast_enabled", 0) == 1;
        } catch (Exception ignored) {
            return false;
        }
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    private static final class Frame {
        final int width, height, left, top, right, bottom;
        Frame(int width, int height, int left, int top, int right, int bottom) {
            this.width = width; this.height = height; this.left = left; this.top = top;
            this.right = right; this.bottom = bottom;
        }
    }
}
