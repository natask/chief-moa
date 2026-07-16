package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaVoiceEndpointingPolicyTest {
    @Test public void fastSpeakerPauseAtOldThresholdDoesNotCommit() {
        assertFalse(MoaVoiceEndpointingPolicy.shouldCommit(1400, 700, true));
        assertFalse(MoaVoiceEndpointingPolicy.shouldCommit(1700, 1100, true));
    }

    @Test public void naturalEndPauseCommitsAfterSpeech() {
        assertTrue(MoaVoiceEndpointingPolicy.shouldCommit(1800, 1200, true));
    }

    @Test public void silenceWithoutSpeechNeverCommits() {
        assertFalse(MoaVoiceEndpointingPolicy.shouldCommit(12000, 12000, false));
    }
}
