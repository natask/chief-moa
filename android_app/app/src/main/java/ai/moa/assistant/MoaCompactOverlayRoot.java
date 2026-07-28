package ai.moa.assistant;

import android.content.Context;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Region;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/**
 * One WindowManager surface for the companion, ribbons, and draft controls.
 *
 * Children retain screen-space coordinates. {@link #commitFrame()} computes
 * their compact union, lays them out locally, and submits exactly one window
 * transaction. Transparent gaps do not consume touches: Android 8+ receives a
 * region containing only visible interactive children.
 */
final class MoaCompactOverlayRoot extends FrameLayout {
    private static final long DRAG_REVEAL_MS = 140L;
    private static final class Slot {
        final Rect screen = new Rect();
        boolean touchable;
    }

    private final WindowManager windowManager;
    private final WindowManager.LayoutParams windowParams;
    private final Map<View, Slot> slots = new LinkedHashMap<>();
    private final Rect windowBounds = new Rect();
    private boolean attached;

    MoaCompactOverlayRoot(Context context, WindowManager windowManager, int overlayType) {
        super(context);
        this.windowManager = windowManager;
        setClipChildren(false);
        setClipToPadding(false);
        windowParams = new WindowManager.LayoutParams(
                1, 1, overlayType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM,
                PixelFormat.TRANSLUCENT);
        windowParams.gravity = Gravity.TOP | Gravity.START;
        windowParams.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING;
        installOptionalPrecisionTouchableRegion();
    }

    /**
     * Insets outside the compact window always pass through by public
     * FLAG_NOT_TOUCH_MODAL behavior. This hidden platform hook additionally
     * passes through gaps between children when an OEM permits it. Android's
     * public API 26 SDK exposes no equivalent; denial is a safe compact-box
     * fallback, never a startup failure.
     */
    private void installOptionalPrecisionTouchableRegion() {
        try {
            Class<?> listenerType = Class.forName(
                    "android.view.ViewTreeObserver$OnComputeInternalInsetsListener");
            Class<?> infoType = Class.forName(
                    "android.view.ViewTreeObserver$InternalInsetsInfo");
            Method add = getViewTreeObserver().getClass().getMethod(
                    "addOnComputeInternalInsetsListener", listenerType);
            Method setTouchableInsets = infoType.getMethod("setTouchableInsets", int.class);
            Field touchableRegion = infoType.getField("touchableRegion");
            Field regionMode = infoType.getField("TOUCHABLE_INSETS_REGION");
            Object listener = Proxy.newProxyInstance(listenerType.getClassLoader(),
                    new Class<?>[]{listenerType}, (proxy, method, arguments) -> {
                        if (!"onComputeInternalInsets".equals(method.getName())
                                || arguments == null || arguments.length != 1) return null;
                        Object info = arguments[0];
                        setTouchableInsets.invoke(info, regionMode.getInt(null));
                        Region region = (Region) touchableRegion.get(info);
                        region.setEmpty();
                        for (Map.Entry<View, Slot> entry : slots.entrySet()) {
                            View child = entry.getKey();
                            Slot slot = entry.getValue();
                            if (!slot.touchable || child.getVisibility() != VISIBLE
                                    || child.getAlpha() <= 0f) continue;
                            MoaCompactOverlayGeometry.Bounds local =
                                    MoaCompactOverlayGeometry.relative(
                                            bounds(slot.screen), bounds(windowBounds));
                            region.op(new Rect(local.left, local.top, local.right, local.bottom),
                                    Region.Op.UNION);
                        }
                        return null;
                    });
            add.invoke(getViewTreeObserver(), listener);
        } catch (ReflectiveOperationException | RuntimeException ignored) {
            // Compact bounds remain touch-modal only inside their small box.
        }
    }

    void attach() {
        if (attached) return;
        windowManager.addView(this, windowParams);
        attached = true;
    }

    void put(View child, Rect screenBounds, boolean touchable) {
        Slot slot = slots.get(child);
        if (slot == null) {
            slot = new Slot();
            slots.put(child, slot);
            addView(child, new FrameLayout.LayoutParams(screenBounds.width(), screenBounds.height()));
        }
        slot.screen.set(screenBounds);
        slot.touchable = touchable;
    }

    void removeSlot(View child) {
        slots.remove(child);
        removeView(child);
    }

    /** Move the whole compact unit without recomputing child relationships. */
    void translateSlots(int dx, int dy) {
        if (dx == 0 && dy == 0) return;
        for (Slot slot : slots.values()) {
            slot.screen.offset(dx, dy);
        }
    }

    /** Hide during movement and reveal once from the final committed position. */
    void setDragHidden(boolean hidden) {
        animate().cancel();
        if (hidden) {
            setAlpha(0f);
            return;
        }
        if (getAlpha() >= 1f) return;
        animate().alpha(1f).setDuration(DRAG_REVEAL_MS).start();
    }

    /** The sole WindowManager layout submission for a compact-overlay frame. */
    void commitFrame() {
        if (slots.isEmpty()) return;
        List<MoaCompactOverlayGeometry.Bounds> visible = new ArrayList<>();
        for (Map.Entry<View, Slot> entry : slots.entrySet()) {
            if (entry.getKey().getVisibility() == VISIBLE && entry.getKey().getAlpha() > 0f) {
                visible.add(bounds(entry.getValue().screen));
            }
        }
        MoaCompactOverlayGeometry.Bounds union = MoaCompactOverlayGeometry.union(visible);
        if (union.empty()) return;
        windowBounds.set(union.left, union.top, union.right, union.bottom);
        for (Map.Entry<View, Slot> entry : slots.entrySet()) {
            View child = entry.getKey();
            MoaCompactOverlayGeometry.Bounds relative = MoaCompactOverlayGeometry.relative(
                    bounds(entry.getValue().screen), union);
            FrameLayout.LayoutParams childParams = (FrameLayout.LayoutParams) child.getLayoutParams();
            childParams.width = relative.width();
            childParams.height = relative.height();
            childParams.leftMargin = relative.left;
            childParams.topMargin = relative.top;
            child.setLayoutParams(childParams);
        }
        windowParams.x = union.left;
        windowParams.y = union.top;
        windowParams.width = Math.max(1, union.width());
        windowParams.height = Math.max(1, union.height());
        if (attached) {
            try {
                windowManager.updateViewLayout(this, windowParams);
            } catch (IllegalArgumentException ignored) {
                // Detached between the coalesced frame and its submission.
            }
        }
        requestLayout();
        requestApplyInsets();
    }

    void detach() {
        if (!attached) return;
        attached = false;
        MoaOverlayWindowLayout.detach(windowManager, this);
        slots.clear();
        removeAllViews();
    }

    Rect windowBoundsForTest() {
        return new Rect(windowBounds);
    }

    private static MoaCompactOverlayGeometry.Bounds bounds(Rect rectangle) {
        return new MoaCompactOverlayGeometry.Bounds(
                rectangle.left, rectangle.top, rectangle.right, rectangle.bottom);
    }
}
