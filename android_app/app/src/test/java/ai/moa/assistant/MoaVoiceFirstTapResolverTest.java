package ai.moa.assistant;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

public final class MoaVoiceFirstTapResolverTest {
    @Test
    public void singleTapStartsContinuingVoiceWhenIdle() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();

        assertEquals(
                Collections.singletonList(MoaVoiceFirstTapResolver.Action.START_CONTINUE_TALK),
                resolver.tapUp(false)
        );
        assertEquals(Collections.emptyList(), resolver.resolve());
        assertFalse(resolver.hasOpenChord());
    }

    @Test
    public void singleTapWhileListeningCommitsAfterTapWindow() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();

        assertEquals(Collections.emptyList(), resolver.tapUp(true));
        assertEquals(
                Collections.singletonList(MoaVoiceFirstTapResolver.Action.COMMIT_AND_END_TALK),
                resolver.resolve()
        );
    }

    @Test
    public void doubleTapStartsFreshVoiceThreadWhenIdle() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();

        assertEquals(
                Collections.singletonList(MoaVoiceFirstTapResolver.Action.START_CONTINUE_TALK),
                resolver.tapUp(false)
        );
        assertEquals(
                Arrays.asList(
                        MoaVoiceFirstTapResolver.Action.CANCEL_TALK_LOOP,
                        MoaVoiceFirstTapResolver.Action.START_FRESH_TALK
                ),
                resolver.tapUp(true)
        );
        assertEquals(Collections.emptyList(), resolver.resolve());
    }

    @Test
    public void doubleTapWhileListeningSupersedesSendWithFreshThread() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();

        assertEquals(Collections.emptyList(), resolver.tapUp(true));
        assertEquals(
                Arrays.asList(
                        MoaVoiceFirstTapResolver.Action.CANCEL_TALK_LOOP,
                        MoaVoiceFirstTapResolver.Action.START_FRESH_TALK
                ),
                resolver.tapUp(true)
        );
        assertEquals(Collections.emptyList(), resolver.resolve());
    }

    @Test
    public void tripleTapCancelsFreshThreadAndOpensChat() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();

        resolver.tapUp(false);
        resolver.tapUp(true);
        assertEquals(
                Arrays.asList(
                        MoaVoiceFirstTapResolver.Action.CANCEL_TALK_LOOP,
                        MoaVoiceFirstTapResolver.Action.OPEN_CHAT
                ),
                resolver.tapUp(true)
        );
        assertEquals(Collections.emptyList(), resolver.resolve());
    }

    @Test
    public void resetClearsDeferredCommit() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();

        resolver.tapUp(true);
        resolver.reset();

        assertEquals(Collections.emptyList(), resolver.resolve());
    }
}
