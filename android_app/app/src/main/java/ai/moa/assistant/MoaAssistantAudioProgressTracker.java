package ai.moa.assistant;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

final class MoaAssistantAudioProgressTracker {
    private final List<SegmentRange> segments = new ArrayList<>();

    private SegmentMetadata pendingSegment;
    private long emittedPcmBytes;
    private String streamedText = "";

    void reset() {
        segments.clear();
        pendingSegment = null;
        emittedPcmBytes = 0L;
        streamedText = "";
    }

    void onAssistantAudioSegment(JSONObject event) {
        pendingSegment = parseSegmentMetadata(event);
        String text = event == null ? "" : event.optString("text", "");
        if (!trim(text).isEmpty()) {
            int start = pendingSegment == null ? -1 : pendingSegment.textStart;
            if (start >= 0 && start <= streamedText.length()) {
                streamedText = streamedText.substring(0, start) + text;
            } else if (streamedText.isEmpty()) {
                streamedText = text;
            } else {
                streamedText = streamedText + " " + text;
            }
        }
    }

    String streamedText() {
        return streamedText;
    }

    void onAssistantAudioFrame(byte[] pcm) {
        int pcmBytes = pcm == null ? 0 : Math.max(0, pcm.length);
        SegmentMetadata segment = pendingSegment;
        pendingSegment = null;
        long startByte = emittedPcmBytes;
        emittedPcmBytes += pcmBytes;
        if (segment == null || pcmBytes <= 0) {
            return;
        }
        int startChar = Math.max(0, segment.textStart);
        int endChar = Math.max(startChar, segment.textEnd);
        segments.add(new SegmentRange(segment.index, startChar, endChar, startByte, emittedPcmBytes));
    }

    PlaybackProgress snapshot(long playedPcmFrames) {
        long playedBytes = clampPlayedBytes(playedPcmFrames);
        return new PlaybackProgress(
                playedBytes,
                MoaAudioPlaybackController.pcmBytesToFrames(playedBytes),
                estimateAssistantTextChars(playedBytes),
                lastCompletedSegmentIndex(playedBytes)
        );
    }

    boolean isFullyPlayed(long playedPcmFrames) {
        return emittedPcmBytes > 0L
                && clampPlayedBytes(playedPcmFrames) >= emittedPcmBytes;
    }

    private long clampPlayedBytes(long playedPcmFrames) {
        long playedBytes = MoaAudioPlaybackController.pcmFramesToBytes(Math.max(0L, playedPcmFrames));
        if (playedBytes < 0L) {
            return 0L;
        }
        return Math.min(playedBytes, emittedPcmBytes);
    }

    private int estimateAssistantTextChars(long playedBytes) {
        int estimated = 0;
        for (SegmentRange segment : segments) {
            if (playedBytes >= segment.endByte) {
                estimated = Math.max(estimated, segment.endChar);
                continue;
            }
            if (playedBytes <= segment.startByte) {
                break;
            }
            long spanBytes = segment.endByte - segment.startByte;
            if (spanBytes <= 0L) {
                estimated = Math.max(estimated, segment.startChar);
                break;
            }
            double ratio = (double) (playedBytes - segment.startByte) / (double) spanBytes;
            int chars = segment.startChar + (int) Math.floor((segment.endChar - segment.startChar) * ratio);
            estimated = Math.max(estimated, clampInt(chars, segment.startChar, segment.endChar));
            break;
        }
        return estimated;
    }

    private int lastCompletedSegmentIndex(long playedBytes) {
        int lastIndex = -1;
        for (SegmentRange segment : segments) {
            if (playedBytes <= segment.startByte) {
                break;
            }
            lastIndex = segment.index;
            if (playedBytes < segment.endByte) {
                break;
            }
        }
        return lastIndex;
    }

    static SegmentMetadata parseSegmentMetadata(JSONObject event) {
        if (event == null) {
            return null;
        }
        int textStart = intValue(event, "text_start", "assistant_text_start", "char_start", "start_char");
        int textEnd = intValue(event, "text_end", "assistant_text_end", "char_end", "end_char");
        String text = trim(event.optString("text", ""));
        if (textStart < 0) {
            textStart = 0;
        }
        if (textEnd < textStart && !text.isEmpty()) {
            textEnd = textStart + text.length();
        }
        if (textEnd < textStart) {
            textEnd = textStart;
        }
        return new SegmentMetadata(
                intValue(event, "segment_index", "index"),
                textStart,
                textEnd
        );
    }

    private static int intValue(JSONObject event, String... keys) {
        for (String key : keys) {
            if (event == null || key == null || !event.has(key)) {
                continue;
            }
            Object value = event.opt(key);
            if (value instanceof Number) {
                return ((Number) value).intValue();
            }
            if (value instanceof String) {
                try {
                    return Integer.parseInt(((String) value).trim());
                } catch (NumberFormatException ignored) {
                }
            }
        }
        return -1;
    }

    private static int clampInt(int value, int min, int max) {
        if (value < min) {
            return min;
        }
        if (value > max) {
            return max;
        }
        return value;
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }

    static final class SegmentMetadata {
        final int index;
        final int textStart;
        final int textEnd;

        SegmentMetadata(int index, int textStart, int textEnd) {
            this.index = index;
            this.textStart = textStart;
            this.textEnd = textEnd;
        }
    }

    static final class PlaybackProgress {
        final long playedPcmBytes;
        final long playedPcmFrames;
        final int assistantTextChars;
        final int assistantSegmentIndex;

        PlaybackProgress(long playedPcmBytes, long playedPcmFrames, int assistantTextChars, int assistantSegmentIndex) {
            this.playedPcmBytes = playedPcmBytes;
            this.playedPcmFrames = playedPcmFrames;
            this.assistantTextChars = assistantTextChars;
            this.assistantSegmentIndex = assistantSegmentIndex;
        }
    }

    private static final class SegmentRange {
        final int index;
        final int startChar;
        final int endChar;
        final long startByte;
        final long endByte;

        SegmentRange(int index, int startChar, int endChar, long startByte, long endByte) {
            this.index = index;
            this.startChar = startChar;
            this.endChar = endChar;
            this.startByte = startByte;
            this.endByte = endByte;
        }
    }
}
