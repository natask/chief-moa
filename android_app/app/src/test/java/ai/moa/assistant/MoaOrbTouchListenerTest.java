package ai.moa.assistant;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;

public final class MoaOrbTouchListenerTest {
    @Test public void dispatcherMapsSendAndHardInterruptWithoutFreshThreadAction() {
        AtomicInteger starts = new AtomicInteger();
        AtomicInteger sends = new AtomicInteger();
        AtomicInteger interrupts = new AtomicInteger();

        MoaOrbTouchActionDispatcher.dispatch(
                java.util.Arrays.asList(
                        MoaVoiceFirstTapResolver.Action.STOP_AND_SEND,
                        MoaVoiceFirstTapResolver.Action.HARD_INTERRUPT),
                starts::incrementAndGet,
                sends::incrementAndGet,
                interrupts::incrementAndGet);

        assertEquals(0, starts.get());
        assertEquals(1, sends.get());
        assertEquals(1, interrupts.get());
    }
}
