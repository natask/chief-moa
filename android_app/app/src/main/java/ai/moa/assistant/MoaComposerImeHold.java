package ai.moa.assistant;

// Signal-to-hold mapping for the keyboard fade guard. The fade family must not
// park (or hide the keyboard) while the chat composer is engaged with the IME,
// and must resume ordinary outside-tap fading as soon as the IME is gone.
//
// On API 30+ the panel's WindowInsets ime() visibility is the authoritative
// live signal. On API 26-29 no such signal exists, so dismissal is observed
// through the events Android does deliver there:
//   - Back while the composer is the IME target (View#onKeyPreIme sees
//     KEYCODE_BACK before the IME consumes it to hide itself),
//   - the panel window losing focus (the system hides the IME when its target
//     window loses focus, e.g. the user taps the app underneath),
//   - the composer losing view focus, and
//   - the panel closing.
// Known API 26-29 limitation: an IME's own hide-keyboard affordance is
// internal to the IME process and produces none of these events; the hold then
// stays engaged until the next observable signal. That failure mode is
// deliberately conservative — the family stays bright and the keyboard is
// never hidden; no wrong fade can happen.
//
// Keystrokes are IME-internal and produce no signal here, so typing can never
// fade the family. Pure state, no Android types, unit-tested on the JVM; the
// service feeds the returned hold into MoaOverlayFadePolicy.setFadeHold.
final class MoaComposerImeHold {
    private boolean held;

    boolean held() {
        return held;
    }

    // Composer gained or lost view focus. Focus gain summons the IME
    // (showPanel's auto-focus, or the user's first tap).
    boolean onComposerFocusChanged(boolean hasFocus) {
        held = hasFocus;
        return held;
    }

    // Composer tapped while already focused: Android re-shows the IME even
    // though no focus change fires, so the hold must re-engage.
    boolean onComposerTapped() {
        held = true;
        return held;
    }

    // Back pressed while the composer is the IME target (onKeyPreIme). The IME
    // consumes the key to dismiss itself; the hold releases with it.
    boolean onBackWhileImeTarget() {
        held = false;
        return held;
    }

    // Panel window focus changed. Losing window focus dismisses the IME
    // system-side; regaining it does NOT re-show the IME, so it never
    // re-engages the hold.
    boolean onPanelWindowFocusChanged(boolean hasWindowFocus) {
        if (!hasWindowFocus) {
            held = false;
        }
        return held;
    }

    // API 30+ authoritative IME visibility from WindowInsets.
    boolean onImeVisibilityChanged(boolean imeVisible) {
        held = imeVisible;
        return held;
    }

    boolean onPanelClosed() {
        held = false;
        return held;
    }
}
