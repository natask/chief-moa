package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaVoiceDraftControlPresentationTest {
    @Test
    public void oldGatewayKeepsDraftControlsHidden() {
        assertFalse(MoaVoiceDraftControlPresentation.from(false, true, false).visible);
    }

    @Test
    public void controlsAppearOnlyAfterExactDraftReady() {
        assertFalse(MoaVoiceDraftControlPresentation.from(true, false, false).visible);
        assertTrue(MoaVoiceDraftControlPresentation.from(true, true, false).visible);
    }

    @Test
    public void oneToggleHonestlyNamesItsNextAction() {
        assertEquals("Pause", MoaVoiceDraftControlPresentation.from(true, true, false).pauseLabel);
        assertEquals("Resume", MoaVoiceDraftControlPresentation.from(true, true, true).pauseLabel);
    }
}
