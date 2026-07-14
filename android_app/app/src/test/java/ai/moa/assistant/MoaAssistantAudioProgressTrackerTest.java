package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaAssistantAudioProgressTrackerTest {
    @Test
    public void parsesAssistantAudioSegmentMetadata() throws Exception {
        JSONObject event = new JSONObject()
                .put("segment_index", 3)
                .put("text_start", 8)
                .put("text", "world");

        MoaAssistantAudioProgressTracker.SegmentMetadata metadata =
                MoaAssistantAudioProgressTracker.parseSegmentMetadata(event);

        assertEquals(3, metadata.index);
        assertEquals(8, metadata.textStart);
        assertEquals(13, metadata.textEnd);
    }

    @Test
    public void snapshotUsesPlaybackHeadAndSegmentBounds() throws Exception {
        MoaAssistantAudioProgressTracker tracker = new MoaAssistantAudioProgressTracker();
        tracker.onAssistantAudioSegment(new JSONObject()
                .put("segment_index", 0)
                .put("text_start", 0)
                .put("text_end", 5));
        tracker.onAssistantAudioFrame(new byte[8000]);
        tracker.onAssistantAudioSegment(new JSONObject()
                .put("segment_index", 1)
                .put("text_start", 5)
                .put("text_end", 10));
        tracker.onAssistantAudioFrame(new byte[8000]);

        MoaAssistantAudioProgressTracker.PlaybackProgress firstHalf =
                tracker.snapshot(MoaAudioPlaybackController.pcmBytesToFrames(4000));
        MoaAssistantAudioProgressTracker.PlaybackProgress beyondEnd =
                tracker.snapshot(MoaAudioPlaybackController.pcmBytesToFrames(20000));

        assertEquals(4000L, firstHalf.playedPcmBytes);
        assertEquals(2, firstHalf.assistantTextChars);
        assertEquals(0, firstHalf.assistantSegmentIndex);
        assertEquals(16000L, beyondEnd.playedPcmBytes);
        assertEquals(10, beyondEnd.assistantTextChars);
        assertEquals(1, beyondEnd.assistantSegmentIndex);
    }

    @Test
    public void legacyFramesStillClampProgressWithoutTextEstimate() {
        MoaAssistantAudioProgressTracker tracker = new MoaAssistantAudioProgressTracker();
        tracker.onAssistantAudioFrame(new byte[3200]);

        MoaAssistantAudioProgressTracker.PlaybackProgress progress =
                tracker.snapshot(MoaAudioPlaybackController.pcmBytesToFrames(6400));

        assertEquals(3200L, progress.playedPcmBytes);
        assertEquals(0, progress.assistantTextChars);
        assertEquals(-1, progress.assistantSegmentIndex);
    }

    @Test
    public void buildsPlaybackProgressJsonMessage() {
        MoaAssistantAudioProgressTracker.PlaybackProgress progress =
                new MoaAssistantAudioProgressTracker.PlaybackProgress(1234L, 617L, 12, 2);

        JSONObject event = MoaVoiceGatewaySocket.buildPlaybackProgressEvent("turn_123", progress, "cancel");

        assertEquals("playback_progress", event.optString("type"));
        assertEquals("turn_123", event.optString("turn_id"));
        assertEquals(1234L, event.optLong("played_audio_bytes"));
        assertEquals(617L, event.optLong("played_pcm_frames"));
        assertEquals(39L, event.optLong("played_pcm_ms"));
        assertEquals(12, event.optInt("assistant_text_chars"));
        assertEquals(2, event.optInt("segment_index"));
        assertEquals("cancel", event.optString("reason"));
        assertTrue(event.has("assistant_text_chars"));
        assertFalse(event.isNull("segment_index"));
    }
}
