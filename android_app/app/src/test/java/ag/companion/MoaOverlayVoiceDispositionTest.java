package ag.companion;

import org.junit.Test;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;

public final class MoaOverlayVoiceDispositionTest {
    @Test
    public void overlayKeepsSendOnMascotAndOwnsOnlyBoundedPauseAndCancelControls() throws Exception {
        for (Field field : OverlayService.class.getDeclaredFields()) {
            assertFalse(field.getName().contains("voiceSendControl"));
        }
        assertNotNull(OverlayService.class.getDeclaredField("voiceDraftPauseControl"));
        assertNotNull(OverlayService.class.getDeclaredField("voiceDraftCancelControl"));
        Method slotSync = OverlayService.class.getDeclaredMethod("syncVoiceDraftControlSlots");
        assertNotNull(slotSync);
    }
}
