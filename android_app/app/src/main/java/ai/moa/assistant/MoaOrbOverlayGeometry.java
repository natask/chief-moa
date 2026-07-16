package ai.moa.assistant;

final class MoaOrbOverlayGeometry {
    static final class Position {
        final int x;
        final int y;
        // The orb top after the always-above rule. When the orb sits too high
        // for the measured card + gap to fit on-screen, the orb itself is the
        // thing that moves (down), never the card (below). Callers must apply
        // this back to the orb window when it differs from the input orbY.
        final int orbY;

        Position(int x, int y, int orbY) {
            this.x = x;
            this.y = y;
            this.orbY = orbY;
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

        // The surface is ALWAYS wholly above the orb. requiredOrbTop is the
        // highest orb position that still leaves room for card + gap above;
        // lowestOrbTop keeps the orb itself on-screen. A card taller than the
        // space over the bottom-most orb cannot fully fit anywhere, so the orb
        // wins the bottom edge and the card clamps to the top margin.
        int lowestOrbTop = Math.max(margin, screenHeight - orbSize - margin);
        int requiredOrbTop = margin + surfaceHeight + gap;
        int adjustedOrbY = clamp(orbY, Math.min(requiredOrbTop, lowestOrbTop), lowestOrbTop);
        int y = Math.max(margin, adjustedOrbY - surfaceHeight - gap);
        return new Position(x, y, adjustedOrbY);
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
