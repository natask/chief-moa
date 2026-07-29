package ag.companion;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class MoaVoiceCaptureGestureResolverTest {
    private final MoaVoiceCaptureGestureResolver resolver = new MoaVoiceCaptureGestureResolver();

    @Test
    public void belowThresholdFallsBackToSend() {
        assertEquals(
                MoaVoiceCaptureGestureResolver.Outcome.SEND,
                resolver.resolve(-47f, 0f, 48f)
        );
    }

    @Test
    public void exactDominanceBoundaryLatchesLeftPause() {
        assertEquals(
                MoaVoiceCaptureGestureResolver.Outcome.PAUSE_FOREGROUND,
                resolver.resolve(-50f, 40f, 48f)
        );
    }

    @Test
    public void ambiguousDiagonalRemainsUnlatched() {
        assertEquals(
                MoaVoiceCaptureGestureResolver.Outcome.SEND,
                resolver.resolve(-60f, -50f, 48f)
        );
    }

    @Test
    public void rightwardDominanceFallsBackToSend() {
        assertEquals(
                MoaVoiceCaptureGestureResolver.Outcome.SEND,
                resolver.resolve(64f, 16f, 48f)
        );
    }

    @Test
    public void upwardDominanceParks() {
        assertEquals(
                MoaVoiceCaptureGestureResolver.Outcome.PARK_DURABLY,
                resolver.resolve(-20f, -64f, 48f)
        );
    }

    @Test
    public void downwardDominanceDiscards() {
        assertEquals(
                MoaVoiceCaptureGestureResolver.Outcome.DISCARD,
                resolver.resolve(12f, 64f, 48f)
        );
    }

    @Test
    public void cancelAlwaysDiscards() {
        assertEquals(
                MoaVoiceCaptureGestureResolver.Outcome.DISCARD,
                resolver.resolveRelease(true, -80f, 0f, 48f)
        );
    }

    @Test
    public void latchThresholdUsesFortyEightDpMinimum() {
        assertEquals(48f, MoaVoiceCaptureGestureResolver.latchThresholdPx(1f, 12), 0.001f);
    }

    @Test
    public void latchThresholdUsesTwoTimesTouchSlopWhenLarger() {
        assertEquals(80f, MoaVoiceCaptureGestureResolver.latchThresholdPx(1f, 40), 0.001f);
    }
}
