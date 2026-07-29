package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
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
        assertFalse(tracker.isFullyPlayed(
                MoaAudioPlaybackController.pcmBytesToFrames(15998)));
        assertTrue(tracker.isFullyPlayed(
                MoaAudioPlaybackController.pcmBytesToFrames(16000)));
    }

    @Test
    public void accumulatesSpokenSegmentTextAndResetsPerTurn() throws Exception {
        MoaAssistantAudioProgressTracker tracker = new MoaAssistantAudioProgressTracker();
        tracker.onAssistantAudioSegment(new JSONObject()
                .put("segment_index", 0)
                .put("text_start", 0)
                .put("text_end", 6)
                .put("text", "Hello "));
        tracker.onAssistantAudioFrame(new byte[8]);
        tracker.onAssistantAudioSegment(new JSONObject()
                .put("segment_index", 1)
                .put("text_start", 6)
                .put("text_end", 12)
                .put("text", "world."));
        tracker.onAssistantAudioFrame(new byte[8]);

        assertEquals("Hello world.", tracker.streamedText());

        tracker.reset();
        assertEquals("", tracker.streamedText());
    }

    @Test
    public void rejectedFrameConsumesPendingTextWithoutAdvancingMapping() throws Exception {
        MoaAssistantAudioProgressTracker tracker = new MoaAssistantAudioProgressTracker();
        tracker.onAssistantAudioSegment(new JSONObject()
                .put("segment_index", 0)
                .put("text_start", 0)
                .put("text_end", 7)
                .put("text", "dropped"));

        tracker.onAssistantAudioFrameRejected();

        assertEquals("", tracker.streamedText());
        assertEquals(0L, tracker.snapshot(Long.MAX_VALUE).playedPcmBytes);
        assertEquals(0, tracker.snapshot(Long.MAX_VALUE).assistantTextChars);
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

    @Test
    public void buildsBoundedIdempotentTtsRetryMessage() {
        JSONObject event = MoaVoiceGatewaySocket.buildTtsRetryEvent("turn_123", "retry_456", 12);

        assertEquals("retry_tts", event.optString("type"));
        assertEquals("turn_123", event.optString("turn_id"));
        assertEquals("retry_456", event.optString("retry_id"));
        assertEquals(12, event.optInt("from_text_char"));
        assertEquals(0, MoaVoiceGatewaySocket.buildTtsRetryEvent("t", "r", -1)
                .optInt("from_text_char"));
    }

    @Test
    public void metadataParsingHandlesAliasesStringsAndInvalidBounds() throws Exception {
        assertNull(MoaAssistantAudioProgressTracker.parseSegmentMetadata(null));

        MoaAssistantAudioProgressTracker.SegmentMetadata aliases =
                MoaAssistantAudioProgressTracker.parseSegmentMetadata(new JSONObject()
                        .put("index", "7")
                        .put("assistant_text_start", " 4 ")
                        .put("assistant_text_end", 9));
        assertEquals(7, aliases.index);
        assertEquals(4, aliases.textStart);
        assertEquals(9, aliases.textEnd);

        MoaAssistantAudioProgressTracker.SegmentMetadata bounded =
                MoaAssistantAudioProgressTracker.parseSegmentMetadata(new JSONObject()
                        .put("segment_index", "not-a-number")
                        .put("char_start", -3)
                        .put("char_end", -8));
        assertEquals(-1, bounded.index);
        assertEquals(0, bounded.textStart);
        assertEquals(0, bounded.textEnd);

        MoaAssistantAudioProgressTracker.SegmentMetadata textFallback =
                MoaAssistantAudioProgressTracker.parseSegmentMetadata(new JSONObject()
                        .put("start_char", 2)
                        .put("text", " hi "));
        assertEquals(2, textFallback.textStart);
        assertEquals(4, textFallback.textEnd);
    }

    @Test
    public void ignoresEmptyFramesAndResetClearsAllProgress() throws Exception {
        MoaAssistantAudioProgressTracker tracker = new MoaAssistantAudioProgressTracker();
        tracker.onAssistantAudioSegment(new JSONObject()
                .put("segment_index", 1)
                .put("text_start", 2)
                .put("text_end", 8));
        tracker.onAssistantAudioFrame(null);
        assertEquals(0L, tracker.snapshot(100L).playedPcmBytes);

        tracker.onAssistantAudioSegment(new JSONObject()
                .put("segment_index", 2)
                .put("text_start", 0)
                .put("text_end", 4));
        tracker.onAssistantAudioFrame(new byte[8]);
        assertEquals(4, tracker.snapshot(4L).assistantTextChars);

        tracker.reset();
        MoaAssistantAudioProgressTracker.PlaybackProgress reset = tracker.snapshot(4L);
        assertEquals(0L, reset.playedPcmBytes);
        assertEquals(0, reset.assistantTextChars);
        assertEquals(-1, reset.assistantSegmentIndex);
    }

    @Test
    public void negativeAndOverflowedPlaybackHeadsFailClosed() throws Exception {
        MoaAssistantAudioProgressTracker tracker = new MoaAssistantAudioProgressTracker();
        tracker.onAssistantAudioSegment(new JSONObject()
                .put("segment_index", 0)
                .put("text_start", 0)
                .put("text_end", 2));
        tracker.onAssistantAudioFrame(new byte[4]);

        assertEquals(0L, tracker.snapshot(-1L).playedPcmBytes);
        assertEquals(0L, tracker.snapshot(Long.MAX_VALUE).playedPcmBytes);
    }
}
