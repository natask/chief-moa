package ai.moa.assistant;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

public final class MoaVoiceFirstTapResolverTest {
    @Test
    public void tapStartsOrInterruptsWhenNoManualCaptureIsActive() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();
        resolver.tapUp();

        assertEquals(
                Collections.singletonList(MoaVoiceFirstTapResolver.Action.START_OR_INTERRUPT),
                resolver.resolve(MoaVoiceFirstTapResolver.CaptureOrigin.NONE)
        );
        assertFalse(resolver.hasOpenChord());
    }

    @Test
    public void tapStopsAndSendsWhenManualCaptureIsActive() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();
        resolver.tapUp();

        assertEquals(
                Collections.singletonList(MoaVoiceFirstTapResolver.Action.STOP_AND_SEND),
                resolver.resolve(MoaVoiceFirstTapResolver.CaptureOrigin.CURRENT_THREAD)
        );
    }

    @Test
    public void doubleTapStartsFreshThreadWhenIdle() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();
        resolver.tapUp();
        resolver.tapUp();

        assertEquals(
                Collections.singletonList(MoaVoiceFirstTapResolver.Action.START_FRESH),
                resolver.resolve(MoaVoiceFirstTapResolver.CaptureOrigin.NONE)
        );
    }

    @Test
    public void doubleTapReplacesActiveCaptureWithFreshThread() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();
        resolver.tapUp();
        resolver.tapUp();

        assertEquals(
                Arrays.asList(
                        MoaVoiceFirstTapResolver.Action.CANCEL_CAPTURE,
                        MoaVoiceFirstTapResolver.Action.START_FRESH
                ),
                resolver.resolve(MoaVoiceFirstTapResolver.CaptureOrigin.CURRENT_THREAD)
        );
    }

    @Test
    public void secondDoubleTapStopsFreshThreadCapture() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();
        resolver.tapUp();
        resolver.tapUp();

        assertEquals(
                Collections.singletonList(MoaVoiceFirstTapResolver.Action.STOP_AND_SEND),
                resolver.resolve(MoaVoiceFirstTapResolver.CaptureOrigin.FRESH_THREAD)
        );
    }

    @Test
    public void tripleTapCancelsActiveCaptureAndOpensChat() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();
        resolver.tapUp();
        resolver.tapUp();
        resolver.tapUp();

        assertEquals(
                Arrays.asList(
                        MoaVoiceFirstTapResolver.Action.CANCEL_CAPTURE,
                        MoaVoiceFirstTapResolver.Action.OPEN_CHAT
                ),
                resolver.resolve(MoaVoiceFirstTapResolver.CaptureOrigin.CURRENT_THREAD)
        );
    }

    @Test
    public void tripleTapOpensChatWithoutVoiceActionWhenIdle() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();
        resolver.tapUp();
        resolver.tapUp();
        resolver.tapUp();

        assertEquals(
                Collections.singletonList(MoaVoiceFirstTapResolver.Action.OPEN_CHAT),
                resolver.resolve(MoaVoiceFirstTapResolver.CaptureOrigin.NONE)
        );
    }

    @Test
    public void fourthTapAndBeyondAreInert() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();
        resolver.tapUp();
        resolver.tapUp();
        resolver.tapUp();
        resolver.tapUp();

        assertEquals(
                Collections.emptyList(),
                resolver.resolve(MoaVoiceFirstTapResolver.CaptureOrigin.NONE)
        );
    }
}
