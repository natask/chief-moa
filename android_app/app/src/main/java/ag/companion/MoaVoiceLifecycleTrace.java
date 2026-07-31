package ag.companion;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Bounded, content-free evidence for one Android streaming voice turn.
 *
 * <p>The trace deliberately records no transcript, audio, URL, token, exception
 * message, session id, or turn id. A fresh local trace id correlates stages in
 * logcat without becoming a cross-system identifier.
 */
final class MoaVoiceLifecycleTrace {
    interface Clock {
        long nowMs();
    }

    interface Sink {
        void write(String event);
    }

    private final Clock clock;
    private final Sink sink;
    private final String traceId;
    private final long startedAtMs;
    private boolean terminal;
    private boolean assistantAudioReceived;
    private boolean devicePlaybackCompleted;
    private long captureStartedElapsedMs = -1L;
    private long commitElapsedMs = -1L;
    private long firstResultElapsedMs = -1L;
    private long firstPartialElapsedMs = -1L;
    private long finalTranscriptElapsedMs = -1L;
    private long firstAssistantTextElapsedMs = -1L;
    private long firstAudioReceiptElapsedMs = -1L;
    private long firstPlayoutElapsedMs = -1L;

    MoaVoiceLifecycleTrace(Clock clock, Sink sink, String traceId) {
        this.clock = clock;
        this.sink = sink;
        this.traceId = safe(traceId);
        this.startedAtMs = clock.nowMs();
    }

    void captureStarted() {
        captureStartedElapsedMs = elapsedMs();
        emit("capture_start", "", false, false);
    }

    void sessionReady() {
        emit("socket_ready", "", false, false);
    }

    void commitRequested(boolean audioCaptured) {
        commitElapsedMs = elapsedMs();
        emit("capture_commit", "", audioCaptured, false);
    }

    void resultReceived(String resultKind) {
        String bounded = boundedResultKind(resultKind);
        long elapsed = elapsedMs();
        if ("assistant_audio".equals(bounded)) {
            assistantAudioReceived = true;
            firstAudioReceiptElapsedMs = first(firstAudioReceiptElapsedMs, elapsed);
        } else if ("assistant_text".equals(bounded)) {
            firstAssistantTextElapsedMs = first(firstAssistantTextElapsedMs, elapsed);
        } else if ("transcript".equals(bounded)) {
            finalTranscriptElapsedMs = first(finalTranscriptElapsedMs, elapsed);
        }
        if (firstResultElapsedMs < 0L) {
            firstResultElapsedMs = elapsed;
        }
        emit("result_received", bounded, false, false);
    }

    void transcriptPartialReceived() {
        long elapsed = elapsedMs();
        firstPartialElapsedMs = first(firstPartialElapsedMs, elapsed);
        firstResultElapsedMs = first(firstResultElapsedMs, elapsed);
        emit("result_received", "transcript_partial", false, false);
    }

    void playbackStarted() {
        firstPlayoutElapsedMs = first(firstPlayoutElapsedMs, elapsedMs());
        emit("playback_start", "", false, false);
    }

    void playbackCompleted() {
        devicePlaybackCompleted = true;
        emit("playback_complete", "", false, false);
    }

    void completed(String status, boolean ttsExpected, boolean audioReceived) {
        terminal("completed", boundedStatus(status), ttsExpected,
                assistantAudioReceived || audioReceived);
    }

    void failed(String reason) {
        terminal("failed", boundedReason(reason), false, false);
    }

    void tornDown(String reason) {
        terminal("teardown", boundedTeardown(reason), false, false);
    }

    private void terminal(
            String event,
            String outcome,
            boolean ttsExpected,
            boolean audioReceived) {
        if (terminal) {
            return;
        }
        terminal = true;
        emit(event, outcome, ttsExpected, audioReceived);
    }

    private void emit(String stage, String outcome, boolean flagA, boolean flagB) {
        if (terminal && !isTerminalStage(stage)) {
            return;
        }
        try {
            JSONObject event = new JSONObject()
                    .put("schema", "android_voice_lifecycle_v1")
                    .put("trace_id", traceId)
                    .put("stage", stage)
                    .put("elapsed_ms", Math.max(0L, clock.nowMs() - startedAtMs));
            if (!outcome.isEmpty()) {
                event.put("outcome", outcome);
            }
            if ("capture_commit".equals(stage)) {
                event.put("audio_captured", flagA);
            } else if ("completed".equals(stage)) {
                event.put("tts_expected", flagA);
                event.put("audio_received", flagB);
                event.put("audible_success",
                        flagA && assistantAudioReceived && devicePlaybackCompleted);
            }
            if (isTerminalStage(stage)) {
                event.put("capture_to_terminal_ms", delta(captureStartedElapsedMs, elapsedMs()));
                event.put("commit_to_result_ms", delta(commitElapsedMs, firstResultElapsedMs));
                event.put("commit_to_terminal_ms", delta(commitElapsedMs, elapsedMs()));
                event.put("capture_to_first_feedback_ms", delta(
                        captureStartedElapsedMs,
                        firstAvailable(
                                firstPartialElapsedMs,
                                finalTranscriptElapsedMs,
                                firstAssistantTextElapsedMs,
                                firstAudioReceiptElapsedMs,
                                firstPlayoutElapsedMs)));
                event.put("capture_to_first_partial_ms",
                        delta(captureStartedElapsedMs, firstPartialElapsedMs));
                event.put("capture_to_final_transcript_ms",
                        delta(captureStartedElapsedMs, finalTranscriptElapsedMs));
                event.put("commit_to_first_assistant_text_ms",
                        delta(commitElapsedMs, firstAssistantTextElapsedMs));
                event.put("commit_to_first_audio_receipt_ms",
                        delta(commitElapsedMs, firstAudioReceiptElapsedMs));
                event.put("commit_to_first_playout_ms",
                        delta(commitElapsedMs, firstPlayoutElapsedMs));
                event.put("audio_receipt_to_playout_ms",
                        delta(firstAudioReceiptElapsedMs, firstPlayoutElapsedMs));
            }
            sink.write(event.toString());
        } catch (Exception ignored) {
            // Evidence must never break the voice turn.
        }
    }

    static String correlationId(String sessionId, String turnId) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(
                    (safe(sessionId) + "\u0000" + safe(turnId))
                            .getBytes(StandardCharsets.UTF_8));
            StringBuilder value = new StringBuilder("vt_");
            for (int i = 0; i < 10; i++) {
                value.append(String.format("%02x", bytes[i]));
            }
            return value.toString();
        } catch (Exception ignored) {
            return "vt_unavailable";
        }
    }

    private static boolean isTerminalStage(String stage) {
        return "completed".equals(stage) || "failed".equals(stage) || "teardown".equals(stage);
    }

    private long elapsedMs() {
        return Math.max(0L, clock.nowMs() - startedAtMs);
    }

    private static long delta(long start, long end) {
        return start < 0L || end < start ? -1L : end - start;
    }

    private static long first(long current, long candidate) {
        return current < 0L ? candidate : current;
    }

    private static long firstAvailable(long... values) {
        long earliest = -1L;
        for (long value : values) {
            if (value >= 0L && (earliest < 0L || value < earliest)) {
                earliest = value;
            }
        }
        return earliest;
    }

    private static String boundedResultKind(String value) {
        return switch (safe(value)) {
            case "transcript", "transcript_partial", "assistant_text", "assistant_audio" -> safe(value);
            default -> "other";
        };
    }

    private static String boundedStatus(String value) {
        return switch (safe(value)) {
            case "completed", "no_speech", "error", "canceled" -> safe(value);
            default -> "other";
        };
    }

    static String boundedReason(String value) {
        String normalized = safe(value).toLowerCase();
        if (normalized.contains("timeout")) return "timeout";
        if (normalized.contains("connect") || normalized.contains("socket")) return "connection";
        if (normalized.contains("capture") || normalized.contains("microphone")) return "capture";
        if (normalized.contains("playback") || normalized.contains("audio frame")) return "playback";
        if (normalized.contains("gateway")) return "gateway";
        return "other";
    }

    private static String boundedTeardown(String value) {
        return switch (safe(value)) {
            case "user_cancel", "replacement", "destroy", "remote_close" -> safe(value);
            default -> "other";
        };
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}
