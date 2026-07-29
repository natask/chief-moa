package ag.companion;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class MoaVoiceInvocationPolicyTest {
    @Test
    public void firstInvocationStartsAndSecondCommitsLatchedCapture() {
        assertEquals(
                MoaVoiceInvocationPolicy.Action.START_LATCHED_CAPTURE,
                MoaVoiceInvocationPolicy.decide(false, false)
        );
        assertEquals(
                MoaVoiceInvocationPolicy.Action.COMMIT_LATCHED_CAPTURE,
                MoaVoiceInvocationPolicy.decide(true, false)
        );
    }

    @Test
    public void invocationCannotDoubleCommitPushToTalk() {
        assertEquals(
                MoaVoiceInvocationPolicy.Action.IGNORE_WHILE_PUSH_TO_TALK,
                MoaVoiceInvocationPolicy.decide(false, true)
        );
        assertEquals(
                MoaVoiceInvocationPolicy.Action.IGNORE_WHILE_PUSH_TO_TALK,
                MoaVoiceInvocationPolicy.decide(true, true)
        );
    }
}
