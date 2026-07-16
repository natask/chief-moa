package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

public final class MoaTranscriptSwipePolicyTest {
    @Test
    public void activeSelectionNeverArmsSwipe() {
        assertSame(MoaTranscriptSwipePolicy.Decision.RELEASE,
                MoaTranscriptSwipePolicy.decide(90, 2, 8, 20, 500, true));
    }

    @Test
    public void longPressNeverTurnsIntoSwipe() {
        assertSame(MoaTranscriptSwipePolicy.Decision.RELEASE,
                MoaTranscriptSwipePolicy.decide(90, 2, 8, 500, 500, false));
    }

    @Test
    public void deliberateHorizontalMoveArmsInEitherDirection() {
        assertSame(MoaTranscriptSwipePolicy.Decision.SWIPE,
                MoaTranscriptSwipePolicy.decide(30, 3, 8, 40, 500, false));
        assertSame(MoaTranscriptSwipePolicy.Decision.SWIPE,
                MoaTranscriptSwipePolicy.decide(-30, 3, 8, 40, 500, false));
    }

    @Test
    public void dismissalThresholdIsDirectionNeutral() {
        assertTrue(MoaTranscriptSwipePolicy.shouldDismiss(121, 400, 120));
        assertTrue(MoaTranscriptSwipePolicy.shouldDismiss(-121, 400, 120));
        assertFalse(MoaTranscriptSwipePolicy.shouldDismiss(90, 400, 120));
        assertFalse(MoaTranscriptSwipePolicy.shouldDismiss(-90, 400, 120));
    }
}
