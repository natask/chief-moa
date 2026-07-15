package ai.moa.assistant;

final class MoaVoiceCaptureGestureResolver {
    private static final float MIN_DOMINANCE_RATIO = 1.25f;

    enum Outcome {
        SEND,
        PAUSE_FOREGROUND,
        PARK_DURABLY,
        DISCARD
    }

    Outcome resolve(float deltaX, float deltaY, float thresholdPx) {
        float absX = Math.abs(deltaX);
        float absY = Math.abs(deltaY);
        float dominant = Math.max(absX, absY);
        float secondary = Math.min(absX, absY);
        if (dominant < thresholdPx) {
            return Outcome.SEND;
        }
        if (!hasDominantAxis(dominant, secondary)) {
            return Outcome.SEND;
        }
        if (absX > absY) {
            return deltaX < 0f ? Outcome.PAUSE_FOREGROUND : Outcome.SEND;
        }
        if (deltaY < 0f) {
            return Outcome.PARK_DURABLY;
        }
        return Outcome.DISCARD;
    }

    Outcome resolveRelease(boolean canceled, float deltaX, float deltaY, float thresholdPx) {
        if (canceled) {
            return Outcome.DISCARD;
        }
        return resolve(deltaX, deltaY, thresholdPx);
    }

    static float latchThresholdPx(float density, int touchSlopPx) {
        float minDisplacementPx = 48f * Math.max(0f, density);
        return Math.max(minDisplacementPx, touchSlopPx * 2f);
    }

    private static boolean hasDominantAxis(float dominant, float secondary) {
        if (dominant <= 0f) {
            return false;
        }
        return secondary <= 0f || dominant / secondary >= MIN_DOMINANCE_RATIO;
    }
}
