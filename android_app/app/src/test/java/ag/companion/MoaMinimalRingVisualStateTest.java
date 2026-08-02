package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaMinimalRingVisualStateTest {
    @Test
    public void hardwareOpenAlwaysWinsAsCapturing() {
        for (VoiceRuntimeState runtime : VoiceRuntimeState.values()) {
            MoaMinimalRingVisualState state = MoaMinimalRingVisualState.resolve(
                    runtime, true, false, false);
            assertEquals(MoaMinimalRingVisualState.Phase.CAPTURING, state.phase);
            assertTrue(state.microphoneOpen);
        }
    }

    @Test
    public void closedMicrophoneNeverClaimsRecording() {
        assertPhase(VoiceRuntimeState.READY, MoaMinimalRingVisualState.Phase.IDLE);
        assertPhase(VoiceRuntimeState.LISTENING, MoaMinimalRingVisualState.Phase.PAUSED);
        assertPhase(VoiceRuntimeState.THINKING, MoaMinimalRingVisualState.Phase.THINKING);
        assertPhase(VoiceRuntimeState.SPEAKING, MoaMinimalRingVisualState.Phase.SPEAKING);
        assertPhase(VoiceRuntimeState.ERROR, MoaMinimalRingVisualState.Phase.ERROR);
    }

    @Test
    public void reducedMotionStopsMotionAndHighContrastIsOpaque() {
        MoaMinimalRingVisualState state = MoaMinimalRingVisualState.resolve(
                VoiceRuntimeState.THINKING, false, true, true);
        assertFalse(state.animate);
        assertEquals(1f, state.alpha, 0f);
        assertEquals(0xFFFFFFFF, state.color);
    }

    @Test
    public void microphoneIntensityIsBoundedAndMonotonic() {
        MoaMinimalRingVisualState state = MoaMinimalRingVisualState.resolve(
                VoiceRuntimeState.LISTENING, true, false, false);
        float quiet = state.intensity(0f, 0f);
        float loud = state.intensity(1f, 0f);
        assertTrue(quiet >= 0f);
        assertTrue(loud <= 1f);
        assertTrue(loud > quiet);
    }

    private static void assertPhase(
            VoiceRuntimeState runtime, MoaMinimalRingVisualState.Phase expected) {
        MoaMinimalRingVisualState state = MoaMinimalRingVisualState.resolve(
                runtime, false, false, false);
        assertEquals(expected, state.phase);
        assertFalse(state.microphoneOpen);
    }
}
