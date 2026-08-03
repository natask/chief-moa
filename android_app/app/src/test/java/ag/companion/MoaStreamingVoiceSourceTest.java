package ag.companion;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class MoaStreamingVoiceSourceTest {
    @Test
    public void explicitBoundedImeSourceOverridesLegacyDefault() {
        assertEquals("android-ime",
                MoaStreamingVoiceSessionController.sourceSurface(true, "android-ime"));
        assertEquals("android-launcher-dictation",
                MoaStreamingVoiceSessionController.sourceSurface(true, "../bad"));
        assertEquals("android-overlay",
                MoaStreamingVoiceSessionController.sourceSurface(false, ""));
    }
}
