package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

public final class MoaVoiceLifecycleTraceTest {
    @Test
    public void recordsCaptureToPlaybackLifecycleWithoutContent() throws Exception {
        FakeClock clock = new FakeClock();
        List<String> events = new ArrayList<>();
        MoaVoiceLifecycleTrace trace =
                new MoaVoiceLifecycleTrace(clock, events::add, "local-trace");

        trace.captureStarted();
        clock.now = 20;
        trace.sessionReady();
        clock.now = 30;
        trace.transcriptPartialReceived();
        clock.now = 45;
        trace.commitRequested(true);
        clock.now = 80;
        trace.resultReceived("transcript");
        clock.now = 120;
        trace.resultReceived("assistant_text");
        clock.now = 150;
        trace.resultReceived("assistant_audio");
        trace.playbackStarted();
        clock.now = 240;
        trace.playbackCompleted();
        clock.now = 250;
        trace.completed("completed", true, true);

        assertEquals(10, events.size());
        JSONObject terminal = new JSONObject(events.get(9));
        assertEquals("android_voice_lifecycle_v1", terminal.getString("schema"));
        assertEquals("completed", terminal.getString("stage"));
        assertEquals(250L, terminal.getLong("elapsed_ms"));
        assertTrue(terminal.getBoolean("tts_expected"));
        assertTrue(terminal.getBoolean("audio_received"));
        assertTrue(terminal.getBoolean("audible_success"));
        assertEquals(30L, terminal.getLong("capture_to_first_feedback_ms"));
        assertEquals(30L, terminal.getLong("capture_to_first_partial_ms"));
        assertEquals(80L, terminal.getLong("capture_to_final_transcript_ms"));
        assertEquals(75L, terminal.getLong("commit_to_first_assistant_text_ms"));
        assertEquals(105L, terminal.getLong("commit_to_first_audio_receipt_ms"));
        assertEquals(105L, terminal.getLong("commit_to_first_playout_ms"));
        assertEquals(0L, terminal.getLong("audio_receipt_to_playout_ms"));
        String joined = String.join("\n", events);
        assertFalse(joined.contains("transcript_text"));
        assertFalse(joined.contains("token"));
        assertFalse(joined.contains("gateway_url"));
    }

    @Test
    public void emitsOnlyOneTerminalAndBoundsFailureDetail() throws Exception {
        FakeClock clock = new FakeClock();
        List<String> events = new ArrayList<>();
        MoaVoiceLifecycleTrace trace =
                new MoaVoiceLifecycleTrace(clock, events::add, "local-trace");

        trace.captureStarted();
        clock.now = 40;
        trace.failed("socket token=secret failed at https://private.example");
        trace.tornDown("destroy");

        assertEquals(2, events.size());
        JSONObject failure = new JSONObject(events.get(1));
        assertEquals("failed", failure.getString("stage"));
        assertEquals("connection", failure.getString("outcome"));
        assertFalse(events.get(1).contains("secret"));
        assertFalse(events.get(1).contains("private.example"));
    }

    @Test
    public void classifiesKnownFailureReasons() {
        assertEquals("timeout", MoaVoiceLifecycleTrace.boundedReason("pending commit timeout"));
        assertEquals("capture", MoaVoiceLifecycleTrace.boundedReason("microphone capture failed"));
        assertEquals("playback", MoaVoiceLifecycleTrace.boundedReason("audio frame playback failed"));
        assertEquals("gateway", MoaVoiceLifecycleTrace.boundedReason("gateway rejected turn"));
        assertEquals("other", MoaVoiceLifecycleTrace.boundedReason("provider said something"));
    }

    @Test
    public void suppressesPostTerminalEvents() {
        FakeClock clock = new FakeClock();
        List<String> events = new ArrayList<>();
        MoaVoiceLifecycleTrace trace =
                new MoaVoiceLifecycleTrace(clock, events::add, "local-trace");

        trace.captureStarted();
        trace.failed("socket closed");
        trace.playbackStarted();
        trace.playbackCompleted();
        trace.resultReceived("assistant_text");

        assertEquals(2, events.size());
    }

    @Test
    public void correlationIsStableBoundedAndDoesNotExposeRawIdentifiers() {
        String first = MoaVoiceLifecycleTrace.correlationId("session-secret", "turn-secret");
        String second = MoaVoiceLifecycleTrace.correlationId("session-secret", "turn-secret");

        assertEquals(first, second);
        assertTrue(first.matches("vt_[0-9a-f]{20}"));
        assertFalse(first.contains("session-secret"));
        assertFalse(first.contains("turn-secret"));
    }

    @Test
    public void playbackDisabledCompletesWithoutClaimingDevicePlayback() throws Exception {
        FakeClock clock = new FakeClock();
        List<String> events = new ArrayList<>();
        MoaVoiceLifecycleTrace trace =
                new MoaVoiceLifecycleTrace(clock, events::add, "local-trace");

        trace.captureStarted();
        trace.commitRequested(true);
        trace.resultReceived("assistant_audio");
        trace.completed("completed", true, true);

        assertEquals(4, events.size());
        assertEquals("result_received", new JSONObject(events.get(2)).getString("stage"));
        JSONObject terminal = new JSONObject(events.get(3));
        assertEquals("completed", terminal.getString("stage"));
        assertTrue(terminal.getBoolean("audio_received"));
        assertFalse(terminal.getBoolean("audible_success"));
        assertFalse(String.join("\n", events).contains("playback_start"));
        assertFalse(String.join("\n", events).contains("playback_complete"));
        assertEquals(-1L, terminal.getLong("capture_to_first_partial_ms"));
        assertEquals(-1L, terminal.getLong("commit_to_first_playout_ms"));
    }

    @Test
    public void firstLocalFeedbackUsesTheFirstPartialAndNeverMovesBackward() throws Exception {
        FakeClock clock = new FakeClock();
        List<String> events = new ArrayList<>();
        MoaVoiceLifecycleTrace trace =
                new MoaVoiceLifecycleTrace(clock, events::add, "local-trace");

        clock.now = 100;
        trace.captureStarted();
        clock.now = 125;
        trace.transcriptPartialReceived();
        clock.now = 150;
        trace.transcriptPartialReceived();
        clock.now = 175;
        trace.commitRequested(true);
        clock.now = 210;
        trace.resultReceived("assistant_text");
        clock.now = 240;
        trace.resultReceived("assistant_audio");
        clock.now = 255;
        trace.playbackStarted();
        clock.now = 300;
        trace.completed("completed", true, true);

        JSONObject terminal = new JSONObject(events.get(events.size() - 1));
        assertEquals(25L, terminal.getLong("capture_to_first_feedback_ms"));
        assertEquals(25L, terminal.getLong("capture_to_first_partial_ms"));
        assertEquals(-1L, terminal.getLong("capture_to_final_transcript_ms"));
        assertEquals(35L, terminal.getLong("commit_to_first_assistant_text_ms"));
        assertEquals(65L, terminal.getLong("commit_to_first_audio_receipt_ms"));
        assertEquals(80L, terminal.getLong("commit_to_first_playout_ms"));
        assertEquals(15L, terminal.getLong("audio_receipt_to_playout_ms"));
    }

    private static final class FakeClock implements MoaVoiceLifecycleTrace.Clock {
        long now;

        @Override
        public long nowMs() {
            return now;
        }
    }
}
