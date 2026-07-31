package ag.companion;

import android.content.Context;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Coordinates the companion and compact ribbons without joining their hit areas.
 *
 * Each child is attached as its own tightly bounded WindowManager window. Android
 * therefore sends a touch to Ag only when it lands inside a visible overlay
 * surface; the large transparent rectangle between the diagonally placed
 * ribbons and companion remains owned by the app underneath.
 */
final class MoaCompactOverlayRoot {
    private static final class Slot {
        final Rect screen = new Rect();
        final WindowManager.LayoutParams params;
        boolean touchable;
        boolean attached;
        boolean dirty = true;

        Slot(int overlayType) {
            params = new WindowManager.LayoutParams(
                    1, 1, overlayType,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                            | WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM,
                    PixelFormat.TRANSLUCENT);
            params.gravity = Gravity.TOP | Gravity.START;
            params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING;
        }
    }

    private final WindowManager windowManager;
    private final int overlayType;
    private final Map<View, Slot> slots = new LinkedHashMap<>();
    private final Rect windowBounds = new Rect();
    private boolean attached;

    MoaCompactOverlayRoot(Context context, WindowManager windowManager, int overlayType) {
        this.windowManager = windowManager;
        this.overlayType = overlayType;
    }

    void attach() {
        if (attached) return;
        attached = true;
        for (Map.Entry<View, Slot> entry : slots.entrySet()) {
            attachSlot(entry.getKey(), entry.getValue());
        }
    }

    void put(View child, Rect screenBounds, boolean touchable) {
        Slot slot = slots.get(child);
        if (slot == null) {
            slot = new Slot(overlayType);
            slots.put(child, slot);
        }
        if (!slot.screen.equals(screenBounds) || slot.touchable != touchable) {
            slot.screen.set(screenBounds);
            slot.touchable = touchable;
            slot.dirty = true;
        }
        if (attached) attachSlot(child, slot);
    }

    void removeSlot(View child) {
        Slot slot = slots.remove(child);
        if (slot == null || !slot.attached) return;
        slot.attached = false;
        try {
            windowManager.removeView(child);
        } catch (IllegalArgumentException ignored) {
            // Already detached by service teardown.
        }
    }

    /** Move every compact surface from the same anchor delta. */
    void translateSlots(int dx, int dy) {
        if (dx == 0 && dy == 0) return;
        for (Slot slot : slots.values()) {
            slot.screen.offset(dx, dy);
            slot.dirty = true;
        }
    }

    /** Submit changed child windows together on the coalesced display frame. */
    void commitFrame() {
        List<MoaCompactOverlayGeometry.Bounds> visible = new ArrayList<>();
        for (Map.Entry<View, Slot> entry : slots.entrySet()) {
            View child = entry.getKey();
            Slot slot = entry.getValue();
            if (child.getVisibility() == View.VISIBLE && child.getAlpha() > 0f) {
                visible.add(bounds(slot.screen));
            }
            attachSlot(child, slot);
            if (!slot.attached || !slot.dirty) continue;
            apply(slot);
            try {
                windowManager.updateViewLayout(child, slot.params);
                slot.dirty = false;
            } catch (IllegalArgumentException ignored) {
                // Detached between the coalesced frame and its submission.
                slot.attached = false;
            }
        }
        MoaCompactOverlayGeometry.Bounds union = MoaCompactOverlayGeometry.union(visible);
        windowBounds.set(union.left, union.top, union.right, union.bottom);
    }

    void detach() {
        attached = false;
        for (Map.Entry<View, Slot> entry : new ArrayList<>(slots.entrySet())) {
            Slot slot = entry.getValue();
            if (!slot.attached) continue;
            slot.attached = false;
            try {
                windowManager.removeView(entry.getKey());
            } catch (IllegalArgumentException ignored) {
                // Already detached.
            }
        }
        slots.clear();
        windowBounds.setEmpty();
    }

    Rect windowBoundsForTest() {
        return new Rect(windowBounds);
    }

    private void attachSlot(View child, Slot slot) {
        if (!attached || slot.attached) return;
        apply(slot);
        windowManager.addView(child, slot.params);
        slot.attached = true;
        slot.dirty = false;
    }

    private static void apply(Slot slot) {
        slot.params.x = slot.screen.left;
        slot.params.y = slot.screen.top;
        slot.params.width = Math.max(1, slot.screen.width());
        slot.params.height = Math.max(1, slot.screen.height());
        if (slot.touchable) {
            slot.params.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        } else {
            slot.params.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        }
    }

    private static MoaCompactOverlayGeometry.Bounds bounds(Rect rectangle) {
        return new MoaCompactOverlayGeometry.Bounds(
                rectangle.left, rectangle.top, rectangle.right, rectangle.bottom);
    }
}
