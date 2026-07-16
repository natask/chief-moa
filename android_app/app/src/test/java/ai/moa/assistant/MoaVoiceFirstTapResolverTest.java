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
    public void singleTapWhileListeningNeverCommitsDraft() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();

        assertEquals(Collections.emptyList(), resolver.tapUp(true));
        assertEquals(Collections.emptyList(), resolver.resolve());
    }

    @Test
    public void doubleTapStartsFreshVoiceThreadWithoutDiscardingFirstDraft() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();

        assertEquals(
                Collections.singletonList(MoaVoiceFirstTapResolver.Action.START_CONTINUE_TALK),
                resolver.tapUp(false)
        );
        assertEquals(
                Collections.singletonList(MoaVoiceFirstTapResolver.Action.START_FRESH_TALK),
                resolver.tapUp(true)
        );
        assertEquals(Collections.emptyList(), resolver.resolve());
    }

    @Test
    public void doubleTapWhileListeningStartsFreshThreadWithoutDiscardingDraft() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();

        assertEquals(Collections.emptyList(), resolver.tapUp(true));
        assertEquals(
                Collections.singletonList(MoaVoiceFirstTapResolver.Action.START_FRESH_TALK),
                resolver.tapUp(true)
        );
        assertEquals(Collections.emptyList(), resolver.resolve());
    }

    @Test
    public void nextResolvedSingleTapCommitsDoubleStartedFreshThread() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();

        resolver.tapUp(false);
        resolver.tapUp(true);
        resolver.resolve();

        assertEquals(Collections.emptyList(), resolver.tapUp(true));
        assertEquals(
                Collections.singletonList(MoaVoiceFirstTapResolver.Action.COMMIT_TALK_LOOP),
                resolver.resolve()
        );
        assertFalse(resolver.hasOpenChord());
    }

    @Test
    public void ordinaryActiveDraftSingleTapRemainsInertForVisibleReviewControls() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();

        resolver.tapUp(false);
        resolver.resolve();

        assertEquals(Collections.emptyList(), resolver.tapUp(true));
        assertEquals(Collections.emptyList(), resolver.resolve());
    }

    @Test
    public void rapidSecondTapDoesNotCommitDoubleStartedFreshThread() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();

        resolver.tapUp(false);
        resolver.tapUp(true);
        resolver.resolve();

        assertEquals(Collections.emptyList(), resolver.tapUp(true));
        assertEquals(
                Collections.singletonList(MoaVoiceFirstTapResolver.Action.START_FRESH_TALK),
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
    public void resetClearsOpenDraftChord() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();

        resolver.tapUp(true);
        resolver.reset();

        assertEquals(Collections.emptyList(), resolver.resolve());
    }
}
