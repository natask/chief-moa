package ai.moa.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public final class MoaPushToTalkGestureSessionIntegrationTest {
    @Test
    public void startAudioNormalFinishCommitsOwnedControllerExactlyOnceWithoutCancel() {
        MoaPushToTalkFinish turn = new MoaPushToTalkFinish();
        AtomicInteger commits = new AtomicInteger();
        turn.start();
        turn.audioObserved();

        dispatch(turn.normalFinish(false, true, false), commits);
        dispatch(turn.normalFinish(false, true, false), commits);

        assertTrue(turn.hasAudioEvidence());
        assertEquals(1, commits.get());
    }

    @Test
    public void normalFinishUsesOwnershipRatherThanTransportActivity() {
        MoaPushToTalkFinish turn = new MoaPushToTalkFinish();
        turn.start();
        turn.audioObserved();

        assertEquals(MoaPushToTalkFinish.Action.COMMIT_STREAMING,
                turn.normalFinish(false, true, false));
    }

    @Test
    public void intentionalCancelNeverCommits() {
        MoaPushToTalkFinish turn = new MoaPushToTalkFinish();
        AtomicInteger commits = new AtomicInteger();
        turn.start();
        turn.audioObserved();

        assertTrue(turn.intentionalCancel());
        dispatch(turn.normalFinish(false, true, false), commits);

        assertEquals(0, commits.get());
        assertFalse(turn.intentionalCancel());
    }

    @Test
    public void releaseDuringPrivateStartupDefersExactlyOnce() {
        MoaPushToTalkFinish turn = new MoaPushToTalkFinish();
        turn.start();

        assertEquals(MoaPushToTalkFinish.Action.DEFER_UNTIL_OPEN,
                turn.normalFinish(true, false, false));
        assertEquals(MoaPushToTalkFinish.Action.IGNORE,
                turn.normalFinish(true, false, false));
    }

    @Test
    public void staleCloseCannotAuthorizeRetryAndRetryStartsOneControllerAndMic() {
        MoaVoiceFailureRetry retry = new MoaVoiceFailureRetry();
        AtomicInteger controllers = new AtomicInteger();
        AtomicInteger microphones = new AtomicInteger();
        retry.arm(30);
        int currentGeneration = retry.invalidateForIntentionalTeardown(30, true);

        assertFalse(retry.consumeAndRun(30, () -> {
            controllers.incrementAndGet();
            microphones.incrementAndGet();
        }));

        retry.arm(currentGeneration);
        assertTrue(retry.consumeAndRun(currentGeneration, () -> {
            controllers.incrementAndGet();
            microphones.incrementAndGet();
        }));
        assertFalse(retry.consumeAndRun(currentGeneration, controllers::incrementAndGet));
        assertEquals(1, controllers.get());
        assertEquals(1, microphones.get());
    }

    private static void dispatch(MoaPushToTalkFinish.Action action, AtomicInteger commits) {
        if (action == MoaPushToTalkFinish.Action.COMMIT_STREAMING
                || action == MoaPushToTalkFinish.Action.COMMIT_LOCAL) {
            commits.incrementAndGet();
        }
    }
}
