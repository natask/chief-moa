package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Application;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import java.util.ArrayList;
import java.util.List;

@RunWith(RobolectricTestRunner.class)
public final class MoaTurnTakingPolicyTest {
    @Test
    public void canonicalModeDefaultsMissingAndInvalidValuesToResponsive() {
        assertEquals("responsive", MoaTurnTakingPolicy.canonicalMode(null));
        assertEquals("responsive", MoaTurnTakingPolicy.canonicalMode(""));
        assertEquals("responsive", MoaTurnTakingPolicy.canonicalMode("invalid"));
        assertEquals("responsive", MoaTurnTakingPolicy.canonicalMode("responsive"));
        assertEquals("patient", MoaTurnTakingPolicy.canonicalMode("patient"));
        assertEquals("strict", MoaTurnTakingPolicy.canonicalMode("strict"));
    }

    @Test
    public void endpointUsesExactResponsiveAndPatientStrictBoundaries() {
        assertEquals(MoaTurnTakingPolicy.EndpointAction.WAIT,
                endpoint("responsive", 650, true, 699));
        assertEquals(MoaTurnTakingPolicy.EndpointAction.COMMIT,
                endpoint("responsive", 650, true, 700));
        for (String mode : new String[]{"patient", "strict"}) {
            assertEquals(MoaTurnTakingPolicy.EndpointAction.WAIT,
                    endpoint(mode, 650, true, 1_599));
            assertEquals(MoaTurnTakingPolicy.EndpointAction.COMMIT,
                    endpoint(mode, 650, true, 1_600));
        }
    }

    @Test
    public void endpointPreservesMinimumNoSpeechAndBackstopBounds() {
        assertEquals(MoaTurnTakingPolicy.EndpointAction.WAIT,
                endpoint("responsive", 649, true, 700));
        assertEquals(MoaTurnTakingPolicy.EndpointAction.WAIT,
                endpoint("responsive", 11_999, false, 0));
        assertEquals(MoaTurnTakingPolicy.EndpointAction.CANCEL_NO_SPEECH,
                endpoint("responsive", 12_000, false, 0));
        assertEquals(MoaTurnTakingPolicy.EndpointAction.WAIT,
                endpoint("strict", 1_799_999, true, 0));
        assertEquals(MoaTurnTakingPolicy.EndpointAction.COMMIT,
                endpoint("strict", 1_800_000, true, 0));
    }

    @Test
    public void strictAloneRefusesCaptureDuringAssistantPlayback() {
        for (String mode : new String[]{"responsive", "patient", "strict"}) {
            assertTrue(MoaTurnTakingPolicy.capturePlan(mode, false, false).allowed);
        }
        assertTrue(MoaTurnTakingPolicy.capturePlan("responsive", true, false).allowed);
        assertTrue(MoaTurnTakingPolicy.capturePlan("patient", true, false).allowed);
        MoaTurnTakingPolicy.CapturePlan refusal =
                MoaTurnTakingPolicy.capturePlan("strict", true, false);
        assertFalse(refusal.allowed);
        assertEquals(MoaTurnTakingPolicy.STRICT_REFUSAL_NOTICE, refusal.reason);
        assertTrue(MoaTurnTakingPolicy.capturePlan("strict", false, false).allowed);
    }

    @Test
    public void strictWrapperRefusalHasNoWrapperMutationAndDispatchesEachNoticeOnce() {
        EffectProbe probe = new EffectProbe();
        boolean allowed = probe.coordinator().admit("strict", true, false);
        if (allowed) probe.events.add("wrapper-mutation");
        assertFalse(allowed);
        assertTrue(probe.playing);
        assertEquals(List.of("discard-mic", "log", "toast", "a11y"), probe.events);
    }

    @Test
    public void strictPushToTalkRefusalDiscardsMicAndMakesReleaseInert() {
        EffectProbe probe = new EffectProbe();
        assertFalse(probe.coordinator().admit("strict", true, true));
        assertEquals(List.of(
                "discard-mic", "cancel-ptt", "log", "toast", "a11y"), probe.events);
    }

    @Test
    public void explicitStopClearsPlaybackBeforeTeardownThenStrictAdmits() {
        EffectProbe probe = new EffectProbe();
        MoaTurnTakingPolicy.CaptureCoordinator coordinator = probe.coordinator();
        coordinator.stopAssistantAudio();
        assertFalse(probe.playing);
        assertEquals(List.of("clear-playing", "teardown"), probe.events);
        probe.events.clear();
        assertTrue(coordinator.admit("strict", probe.playing, false));
        assertEquals(List.of("clear-playing", "teardown"), probe.events);
    }

    @Test
    public void responsiveAndPatientTeardownBeforeWrapperMutation() {
        for (String mode : new String[]{"responsive", "patient"}) {
            EffectProbe probe = new EffectProbe();
            boolean allowed = probe.coordinator().admit(mode, true, false);
            if (allowed) probe.events.add("wrapper-mutation");
            assertTrue(allowed);
            assertFalse(probe.playing);
            assertEquals(List.of(
                    "clear-playing", "teardown", "wrapper-mutation"), probe.events);
        }
    }

    @Test
    public void voiceActivityKeepsExact449And450Threshold() {
        assertFalse(MoaTurnTakingPolicy.hasVoiceActivity(pcmSample(449)));
        assertTrue(MoaTurnTakingPolicy.hasVoiceActivity(pcmSample(450)));
    }

    @Test
    public void prefsReadCachedTurnTakingModeAndFailSafeToResponsive() {
        Application context = RuntimeEnvironment.getApplication();
        MoaPrefs.setAgentProfileJson(context, "");
        assertEquals("responsive", MoaPrefs.turnTakingMode(context));
        MoaPrefs.setAgentProfileJson(context, "{\"turn_taking_mode\":\"bogus\"}");
        assertEquals("responsive", MoaPrefs.turnTakingMode(context));
        MoaPrefs.setAgentProfileJson(context, "{\"turn_taking_mode\":\"patient\"}");
        assertEquals("patient", MoaPrefs.turnTakingMode(context));
        MoaPrefs.setAgentProfileJson(context, "");
    }

    private static MoaTurnTakingPolicy.EndpointAction endpoint(
            String mode, long recordingAgeMs, boolean heardSpeech, long silenceMs) {
        return MoaTurnTakingPolicy.endpointAction(
                mode, recordingAgeMs, heardSpeech, silenceMs);
    }

    private static byte[] pcmSample(int sample) {
        return new byte[]{(byte) (sample & 0xff), (byte) ((sample >>> 8) & 0xff)};
    }

    private static final class EffectProbe {
        final List<String> events = new ArrayList<>();
        boolean playing = true;

        MoaTurnTakingPolicy.CaptureCoordinator coordinator() {
            return new MoaTurnTakingPolicy.CaptureCoordinator(
                    () -> { playing = false; events.add("clear-playing"); },
                    () -> events.add("teardown"),
                    () -> events.add("discard-mic"),
                    () -> events.add("cancel-ptt"),
                    reason -> events.add("log"),
                    reason -> events.add("toast"),
                    reason -> events.add("a11y"));
        }
    }
}
