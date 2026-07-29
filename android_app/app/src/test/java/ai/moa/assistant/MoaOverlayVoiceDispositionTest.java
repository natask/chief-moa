package ai.moa.assistant;

import org.junit.Test;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;

public final class MoaOverlayVoiceDispositionTest {
    @Test
    public void overlayHasNoSeparateVoiceDraftDispositionWindows() {
        for (Field field : OverlayService.class.getDeclaredFields()) {
            assertFalse(field.getName().contains("voiceCancelControl"));
            assertFalse(field.getName().contains("voiceSendControl"));
        }
        for (Method method : OverlayService.class.getDeclaredMethods()) {
            assertFalse(method.getName().contains("VoiceDraftControl"));
        }
        assertNull(getClass().getClassLoader().getResource(
                "ai/moa/assistant/MoaVoiceDraftControls.class"));
    }
}
