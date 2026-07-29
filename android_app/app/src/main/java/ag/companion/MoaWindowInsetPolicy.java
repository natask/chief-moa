package ag.companion;

/**
 * How the overlay unit reads system insets below API 30.
 *
 * {@code WindowInsets.getInsets(Type.statusBars())} and its siblings only exist
 * from API 30. This app's minSdk is 26 and it has no AndroidX dependency, so the
 * pre-30 path is written out here rather than borrowed from
 * {@code WindowInsetsCompat}.
 *
 * The mapping is the same one AndroidX uses for API 21-29:
 *
 * <ul>
 *   <li>{@code statusBars().top} and {@code navigationBars().bottom} come from
 *       {@code getSystemWindowInsetTop/Bottom()}. Like the modern call, those
 *       track current visibility, so an immersive app that has hidden its status
 *       bar reports zero on both paths rather than leaving a phantom gap.</li>
 *   <li>{@code displayCutout().top} comes from
 *       {@code DisplayCutout.getSafeInsetTop()} on API 28-29, taken as a maximum
 *       against the system window inset. On a normally-laid-out window the
 *       cutout is already inside the system window inset and the maximum is a
 *       no-op; it only bites for a window that extends into the cutout.</li>
 *   <li>Below API 28 there is no cutout API and no device with a cutout, so the
 *       system window inset is the whole answer.</li>
 * </ul>
 *
 * The bottom inset deliberately does not fold in the IME. The companion window
 * these insets are read from is {@code FLAG_NOT_FOCUSABLE} and never resizes for
 * the keyboard, so its system window inset is the navigation bar alone — which
 * is what the ribbons want, because they must not move for the IME.
 *
 * Pure arithmetic, so the combination rule is unit tested; the two
 * version-gated reads that feed it live in {@link MoaOverlayUnitController}.
 */
final class MoaWindowInsetPolicy {
    private MoaWindowInsetPolicy() {
    }

    /**
     * @param systemWindowInsetTop {@code WindowInsets.getSystemWindowInsetTop()}
     * @param cutoutSafeInsetTop   {@code DisplayCutout.getSafeInsetTop()}, or 0
     *                             when there is no cutout or no cutout API
     */
    static int legacyTop(int systemWindowInsetTop, int cutoutSafeInsetTop) {
        return Math.max(0, Math.max(systemWindowInsetTop, cutoutSafeInsetTop));
    }

    /**
     * @param systemWindowInsetBottom {@code WindowInsets.getSystemWindowInsetBottom()}
     */
    static int legacyBottom(int systemWindowInsetBottom) {
        return Math.max(0, systemWindowInsetBottom);
    }
}
