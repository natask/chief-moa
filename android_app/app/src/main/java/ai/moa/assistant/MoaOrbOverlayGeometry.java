package ai.moa.assistant;

final class MoaOrbOverlayGeometry {
    static final class Position {
        final int x;
        final int y;
        final boolean aboveOrb;

        Position(int x, int y, boolean aboveOrb) {
            this.x = x;
            this.y = y;
            this.aboveOrb = aboveOrb;
        }
    }

    private MoaOrbOverlayGeometry() {
    }

    static Position anchoredSurface(
            int screenWidth,
            int screenHeight,
            int margin,
            int gap,
            int orbX,
            int orbY,
            int orbSize,
            int surfaceWidth,
            int surfaceHeight
    ) {
        int orbCenterX = orbX + orbSize / 2;
        int minX = surfaceWidth + margin * 2 <= screenWidth ? margin : 0;
        int maxX = Math.max(minX, screenWidth - surfaceWidth - minX);
        int x = clamp(orbCenterX - surfaceWidth / 2, minX, maxX);

        int aboveY = orbY - surfaceHeight - gap;
        int belowY = orbY + orbSize + gap;
        boolean above = surfaceHeight <= orbY - gap - margin;
        int maxY = Math.max(margin, screenHeight - surfaceHeight - margin);
        int y = clamp(above ? aboveY : belowY, margin, maxY);
        return new Position(x, y, above);
    }

    static boolean isInRemoveTarget(
            int screenWidth,
            int screenHeight,
            int orbX,
            int orbY,
            int orbSize,
            int bottomZoneHeight,
            int horizontalRadius
    ) {
        int centerX = orbX + orbSize / 2;
        int centerY = orbY + orbSize / 2;
        return centerY >= screenHeight - bottomZoneHeight
                && Math.abs(centerX - screenWidth / 2) <= horizontalRadius;
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(value, max));
    }
}
