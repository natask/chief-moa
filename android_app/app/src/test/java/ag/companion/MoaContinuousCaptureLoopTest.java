package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.Test;

public final class MoaContinuousCaptureLoopTest {

    /** Records the teardown so "the microphone was released" is an assertion. */
    private static final class FakeCapture implements MoaContinuousCaptureLoop.Capture {
        final List<String> calls = new ArrayList<>();
        String notice = "";

        @Override
        public void cancelPendingRestart() {
            calls.add("cancelPendingRestart");
        }

        @Override
        public void releaseWarmMic() {
            calls.add("releaseWarmMic");
        }

        @Override
        public void stopActiveCapture() {
            calls.add("stopActiveCapture");
        }

        @Override
        public void announceExit(String value) {
            calls.add("announceExit");
            notice = value;
        }

        @Override
        public void markReadyToRearm() {
            calls.add("markReadyToRearm");
        }
    }

    private static final List<String> FULL_TEARDOWN = Arrays.asList(
            "cancelPendingRestart",
            "releaseWarmMic",
            "stopActiveCapture",
            "announceExit",
            "markReadyToRearm");

    @Test
    public void realSpeechKeepsTheLoopArmedIndefinitely() {
        FakeCapture capture = new FakeCapture();
        MoaContinuousCaptureLoop loop = new MoaContinuousCaptureLoop(capture);
        loop.arm(0);

        for (int turn = 0; turn < 200; turn++) {
            assertTrue("turn " + turn, loop.allowRearm(true, turn * 1000L));
        }

        assertTrue(loop.armed());
        assertEquals(0, loop.consecutiveSilentTurns());
        assertTrue(capture.calls.isEmpty());
    }

    @Test
    public void aSingleSpokenTurnResetsTheSilenceCount() {
        FakeCapture capture = new FakeCapture();
        MoaContinuousCaptureLoop loop = new MoaContinuousCaptureLoop(capture);
        loop.arm(0);

        // Pausing to think, or one bad recognition, must never drop the user.
        for (int i = 0; i < MoaContinuousCaptureLoop.MAX_SILENT_TURNS - 1; i++) {
            assertTrue(loop.allowRearm(false, 1000L));
        }
        assertEquals(MoaContinuousCaptureLoop.MAX_SILENT_TURNS - 1, loop.consecutiveSilentTurns());

        assertTrue(loop.allowRearm(true, 2000L));
        assertEquals(0, loop.consecutiveSilentTurns());
        assertTrue(loop.armed());
        assertTrue(capture.calls.isEmpty());
    }

    @Test
    public void consecutiveSilentTurnsLeaveTheLoopAndReleaseTheMicrophone() {
        FakeCapture capture = new FakeCapture();
        MoaContinuousCaptureLoop loop = new MoaContinuousCaptureLoop(capture);
        loop.arm(0);

        for (int i = 0; i < MoaContinuousCaptureLoop.MAX_SILENT_TURNS - 1; i++) {
            assertTrue(loop.allowRearm(false, 1000L));
        }
        assertFalse(loop.allowRearm(false, 1000L));

        assertFalse(loop.armed());
        assertEquals(FULL_TEARDOWN, capture.calls);
        assertTrue(capture.notice.contains("quiet"));
        assertTrue(capture.notice.contains("Tap to start again"));
    }

    @Test
    public void theSessionCapEndsTheLoopEvenWhileSpeechContinues() {
        FakeCapture capture = new FakeCapture();
        MoaContinuousCaptureLoop loop = new MoaContinuousCaptureLoop(capture);
        loop.arm(0);

        assertTrue(loop.allowRearm(true, MoaContinuousCaptureLoop.MAX_SESSION_MS - 1));
        assertFalse(loop.allowRearm(true, MoaContinuousCaptureLoop.MAX_SESSION_MS));

        assertFalse(loop.armed());
        assertEquals(FULL_TEARDOWN, capture.calls);
        assertTrue(capture.notice.contains("45 minutes"));
    }

    @Test
    public void theMicrophoneIsReleasedBeforeAnythingElseOnBothExits() {
        for (boolean heardSpeech : new boolean[]{true, false}) {
            FakeCapture capture = new FakeCapture();
            MoaContinuousCaptureLoop loop = new MoaContinuousCaptureLoop(capture);
            loop.arm(0);
            long now = 0;
            while (loop.allowRearm(heardSpeech, now)) {
                now += 1000;
                if (now > MoaContinuousCaptureLoop.MAX_SESSION_MS + 1000) {
                    break;
                }
            }

            // The queued re-arm is dropped first so nothing can reopen a mic
            // behind the teardown, then both the warm mic and any live capture
            // session are released.
            assertEquals(FULL_TEARDOWN, capture.calls);
            assertTrue(capture.calls.indexOf("cancelPendingRestart")
                    < capture.calls.indexOf("releaseWarmMic"));
            assertTrue(capture.calls.indexOf("releaseWarmMic")
                    < capture.calls.indexOf("announceExit"));
        }
    }

    @Test
    public void theUserIsLeftInAReArmableStateNotALockout() {
        FakeCapture capture = new FakeCapture();
        MoaContinuousCaptureLoop loop = new MoaContinuousCaptureLoop(capture);
        loop.arm(0);
        while (loop.allowRearm(false, 1000L)) {
            // drain to the silence bound
        }
        assertFalse(loop.armed());

        // The normal gesture arms it again immediately, with a fresh budget.
        loop.arm(5000);
        assertTrue(loop.armed());
        assertEquals(0, loop.consecutiveSilentTurns());
        assertTrue(loop.allowRearm(false, 6000));
    }

    @Test
    public void aDisarmedLoopNeverRearmsAndNeverTearsDownTwice() {
        FakeCapture capture = new FakeCapture();
        MoaContinuousCaptureLoop loop = new MoaContinuousCaptureLoop(capture);

        assertFalse(loop.allowRearm(true, 1000));
        assertTrue(capture.calls.isEmpty());

        loop.arm(0);
        loop.disarm();
        assertFalse(loop.allowRearm(false, 1000));
        assertTrue(capture.calls.isEmpty());
    }

    @Test
    public void armingIsIdempotentSoTheSessionClockIsNotRestartedMidLoop() {
        MoaContinuousCaptureLoop loop = new MoaContinuousCaptureLoop(new FakeCapture());
        loop.arm(0);
        loop.allowRearm(false, 1000);
        loop.arm(30_000);

        assertEquals(1, loop.consecutiveSilentTurns());
        assertEquals(30_000, loop.elapsedMs(30_000));
    }

    @Test
    public void remainingTimeCountsDownFromTheCap() {
        MoaContinuousCaptureLoop loop = new MoaContinuousCaptureLoop(new FakeCapture());
        assertEquals(0, loop.remainingMs(0));

        loop.arm(0);
        assertEquals(MoaContinuousCaptureLoop.MAX_SESSION_MS, loop.remainingMs(0));
        assertEquals(0, loop.remainingMs(MoaContinuousCaptureLoop.MAX_SESSION_MS * 2));
    }

    @Test
    public void theBoundsAreGenerousEnoughToKeepHandsFreeCaptureUsable() {
        // Guards against someone quietly tightening these into a broken feature.
        assertTrue(MoaContinuousCaptureLoop.MAX_SILENT_TURNS >= 4);
        assertTrue(MoaContinuousCaptureLoop.MAX_SESSION_MS >= 20L * 60L * 1000L);
    }
}
