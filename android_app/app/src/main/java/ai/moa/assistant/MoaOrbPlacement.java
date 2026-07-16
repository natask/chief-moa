package ai.moa.assistant;

// Where the lion lands when the user presses "Start assistant circle": centered
// exactly under the activating touch, clamped only so the orb stays inside the
// safe display bounds. Activations that carry no touch point (accessibility
// services, keyboard/d-pad, programmatic clicks) fall back to the Start
// button's own on-screen center. Pure math, no Android types, so placement is
// unit-testable on the JVM.
final class MoaOrbPlacement {
    // A click dispatches immediately after its ACTION_UP, so a captured touch
    // older than this cannot belong to the click being handled — it is a
    // leftover from an earlier cancelled press and must not place the orb.
    static final long TOUCH_FRESH_MS = 400;

    private MoaOrbPlacement() {
    }

    // True when a captured ACTION_UP should drive placement for a click firing
    // at nowUptimeMs. Stale or clock-skewed captures fall back to the button
    // center, same as touchless activations.
    static boolean touchPlacementUsable(boolean touchCaptured, long touchUpUptimeMs, long nowUptimeMs) {
        if (!touchCaptured) {
            return false;
        }
        long age = nowUptimeMs - touchUpUptimeMs;
        return age >= 0 && age <= TOUCH_FRESH_MS;
    }

    // Window top-left (one axis) that centers an orb of orbSizePx on centerPx,
    // clamped so the whole orb stays inside [safeMinPx, safeMaxPx]. When the
    // safe range cannot fit the orb at all, it pins to the safe minimum.
    static int topLeftForCenter(float centerPx, int orbSizePx, int safeMinPx, int safeMaxPx) {
        int topLeft = Math.round(centerPx - orbSizePx / 2f);
        int maxTopLeft = safeMaxPx - orbSizePx;
        if (maxTopLeft < safeMinPx) {
            return safeMinPx;
        }
        return Math.max(safeMinPx, Math.min(topLeft, maxTopLeft));
    }
}
