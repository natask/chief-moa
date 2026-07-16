package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

// Keyboard-guard signal mapping, including the API 26-29 dismissal paths that
// have no WindowInsets ime() signal: Back seen via onKeyPreIme, and the panel
// window losing focus. See MoaComposerImeHold for the documented limitation
// (an IME's internal hide button is unobservable pre-30; the hold then stays
// engaged — conservative — until the next signal).
public final class MoaComposerImeHoldTest {
    @Test
    public void composerFocusEngagesAndReleases() {
        MoaComposerImeHold hold = new MoaComposerImeHold();
        assertFalse(hold.held());
        assertTrue(hold.onComposerFocusChanged(true));
        assertFalse(hold.onComposerFocusChanged(false));
    }

    @Test
    public void backWhileImeTargetReleasesOnOlderApis() {
        MoaComposerImeHold hold = new MoaComposerImeHold();
        hold.onComposerFocusChanged(true);

        // API 26-29: Back dismisses the IME while the composer keeps view
        // focus; onKeyPreIme is the only dismissal signal.
        assertFalse(hold.onBackWhileImeTarget());
        assertFalse(hold.held());
    }

    @Test
    public void composerTapReEngagesAfterBackDismissal() {
        MoaComposerImeHold hold = new MoaComposerImeHold();
        hold.onComposerFocusChanged(true);
        hold.onBackWhileImeTarget();

        // Tapping the still-focused composer re-shows the IME with no focus
        // change; the tap signal must re-engage the hold.
        assertTrue(hold.onComposerTapped());
    }

    @Test
    public void windowFocusLossReleasesButRegainDoesNotEngage() {
        MoaComposerImeHold hold = new MoaComposerImeHold();
        hold.onComposerFocusChanged(true);

        // Tapping the app underneath moves window focus and the system hides
        // the IME with it.
        assertFalse(hold.onPanelWindowFocusChanged(false));
        // Getting window focus back does not re-show the IME.
        assertFalse(hold.onPanelWindowFocusChanged(true));
    }

    @Test
    public void windowFocusGainNeverEngagesFromIdle() {
        MoaComposerImeHold hold = new MoaComposerImeHold();
        assertFalse(hold.onPanelWindowFocusChanged(true));
    }

    @Test
    public void imeVisibilityIsAuthoritative() {
        MoaComposerImeHold hold = new MoaComposerImeHold();
        assertTrue(hold.onImeVisibilityChanged(true));
        assertFalse(hold.onImeVisibilityChanged(false));
    }

    @Test
    public void panelCloseReleases() {
        MoaComposerImeHold hold = new MoaComposerImeHold();
        hold.onComposerFocusChanged(true);
        assertFalse(hold.onPanelClosed());
    }
}
