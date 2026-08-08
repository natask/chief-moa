package ag.companion;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaVoiceTerminalGateTest {
    @Test
    public void terminalCleanupAndNotificationAreAdmittedExactlyOnce() {
        MoaVoiceTerminalGate gate = new MoaVoiceTerminalGate();
        AtomicInteger captureStops = new AtomicInteger();
        AtomicInteger playbackStops = new AtomicInteger();
        AtomicInteger socketDestroys = new AtomicInteger();
        AtomicInteger notifications = new AtomicInteger();

        terminate(gate, captureStops, playbackStops, socketDestroys, notifications);
        terminate(gate, captureStops, playbackStops, socketDestroys, notifications);

        assertEquals(1, captureStops.get());
        assertEquals(1, playbackStops.get());
        assertEquals(1, socketDestroys.get());
        assertEquals(1, notifications.get());
        assertFalse(gate.allowsEvents());
    }

    @Test
    public void lateEventsStayRejectedPermanentlyForThisController() {
        MoaVoiceTerminalGate gate = new MoaVoiceTerminalGate();
        assertTrue(gate.beginTermination());
        assertFalse(gate.beginTermination());
        assertFalse(gate.allowsEvents());
    }

    private static void terminate(
            MoaVoiceTerminalGate gate,
            AtomicInteger captureStops,
            AtomicInteger playbackStops,
            AtomicInteger socketDestroys,
            AtomicInteger notifications
    ) {
        if (!gate.beginTermination()) return;
        captureStops.incrementAndGet();
        playbackStops.incrementAndGet();
        socketDestroys.incrementAndGet();
        notifications.incrementAndGet();
    }
}
