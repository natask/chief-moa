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

    /** The painted remove target's window rectangle, bottom-centre. */
    static final class Bounds {
        final int left;
        final int top;
        final int width;
        final int height;

        Bounds(int left, int top, int width, int height) {
            this.left = left;
            this.top = top;
            this.width = width;
            this.height = height;
        }

        int right() {
            return left + width;
        }

        int bottom() {
            return top + height;
        }
    }

    static Bounds removeTargetBounds(
            int screenWidth,
            int screenHeight,
            int targetWidth,
            int targetHeight,
            int bottomInset
    ) {
        int left = Math.max(0, (screenWidth - targetWidth) / 2);
        int top = Math.max(0, screenHeight - targetHeight - Math.max(0, bottomInset));
        return new Bounds(left, top, targetWidth, targetHeight);
    }

    /**
     * Whether the dragged companion is over the remove target.
     *
     * This used to test a large invisible zone — 270dp wide by 170dp tall against
     * a 150x58dp painted pill — so a drag that merely passed near the bottom of
     * the screen armed removal. The zone is now the painted rectangle inflated by
     * one tolerance, so what arms removal is what the user can see, and the
     * companion's centre has to actually be on it.
     */
    static boolean isInRemoveTarget(
            Bounds target,
            int orbX,
            int orbY,
            int orbSize,
            int tolerance
    ) {
        if (target == null) {
            return false;
        }
        int centerX = orbX + orbSize / 2;
        int centerY = orbY + orbSize / 2;
        int slack = Math.max(0, tolerance);
        return centerX >= target.left - slack
                && centerX <= target.right() + slack
                && centerY >= target.top - slack
                && centerY <= target.bottom() + slack;
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(value, max));
    }
}
