package ai.moa.assistant;

// Anchoring math for surfaces that hang off the lion orb (chat panel, voice
// transcript card). Horizontally the surface centers on the orb; vertically it
// prefers the side of the orb with room, then clamps fully on screen. Pure
// math, no Android types, so "an open surface follows the orb wherever it
// moves" (drag or start-under-finger reposition) is unit-testable on the JVM.
final class MoaSurfaceAnchor {
    private MoaSurfaceAnchor() {
    }

    static int anchoredX(int orbX, int orbSizePx, int surfaceWidthPx, int screenWidthPx, int marginPx) {
        int orbCenterX = orbX + orbSizePx / 2;
        // A surface wider than the screen minus margins hugs the raw edges.
        int minX = surfaceWidthPx + marginPx * 2 <= screenWidthPx ? marginPx : 0;
        int maxX = Math.max(minX, screenWidthPx - surfaceWidthPx - minX);
        return Math.max(minX, Math.min(orbCenterX - surfaceWidthPx / 2, maxX));
    }

    static int anchoredY(int orbY, int orbSizePx, int surfaceHeightPx, int screenHeightPx, int marginPx, int gapPx) {
        int aboveY = orbY - surfaceHeightPx - gapPx;
        int belowY = orbY + orbSizePx + gapPx;
        int aboveSpace = orbY - gapPx - marginPx;
        int belowSpace = screenHeightPx - belowY - marginPx;
        boolean placeAbove = surfaceHeightPx <= aboveSpace || aboveSpace >= belowSpace;
        int y = placeAbove ? aboveY : belowY;
        return Math.max(marginPx, Math.min(y, screenHeightPx - surfaceHeightPx - marginPx));
    }
}
