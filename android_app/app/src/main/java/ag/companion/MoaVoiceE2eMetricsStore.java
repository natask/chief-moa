package ag.companion;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Private, bounded rolling Android voice outcomes. Contains no user content or raw identity. */
final class MoaVoiceE2eMetricsStore {
    private static final String PREFS = "moa_voice_e2e_metrics";
    private static final String KEY = "samples_v1";
    private static final int MAX_SAMPLES = 100;
    private static final Object STORE_LOCK = new Object();

    static void record(Context context, String eventJson) {
        try {
            JSONObject event = new JSONObject(eventJson);
            String stage = event.optString("stage", "");
            if (!("completed".equals(stage) || "failed".equals(stage) || "teardown".equals(stage))) return;
            JSONObject sample = new JSONObject()
                    .put("stage", stage)
                    .put("outcome", event.optString("outcome", "other"))
                    .put("capture_to_terminal_ms", boundedDuration(event.optLong("capture_to_terminal_ms", -1L)))
                    .put("commit_to_result_ms", boundedDuration(event.optLong("commit_to_result_ms", -1L)))
                    .put("commit_to_terminal_ms", boundedDuration(event.optLong("commit_to_terminal_ms", -1L)))
                    .put("capture_to_first_feedback_ms", boundedDuration(
                            event.optLong("capture_to_first_feedback_ms", -1L)))
                    .put("capture_to_first_partial_ms", boundedDuration(
                            event.optLong("capture_to_first_partial_ms", -1L)))
                    .put("capture_to_final_transcript_ms", boundedDuration(
                            event.optLong("capture_to_final_transcript_ms", -1L)))
                    .put("commit_to_first_assistant_text_ms", boundedDuration(
                            event.optLong("commit_to_first_assistant_text_ms", -1L)))
                    .put("commit_to_first_audio_receipt_ms", boundedDuration(
                            event.optLong("commit_to_first_audio_receipt_ms", -1L)))
                    .put("commit_to_first_playout_ms", boundedDuration(
                            event.optLong("commit_to_first_playout_ms", -1L)))
                    .put("audio_receipt_to_playout_ms", boundedDuration(
                            event.optLong("audio_receipt_to_playout_ms", -1L)))
                    .put("audible_success", "completed".equals(stage)
                            && event.optBoolean("audible_success", false));
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            synchronized (STORE_LOCK) {
                JSONArray samples = load(prefs);
                appendBounded(samples, sample);
                prefs.edit().putString(KEY, samples.toString()).commit();
            }
        } catch (Exception ignored) {
        }
    }

    static String summary(Context context) {
        return summary(load(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)));
    }

    static String summary(JSONArray samples) {
        int completed = 0;
        int failed = 0;
        int teardown = 0;
        int audible = 0;
        List<Long> latencies = new ArrayList<>();
        List<Long> firstFeedbackLatencies = new ArrayList<>();
        for (int i = 0; i < samples.length(); i++) {
            JSONObject sample = samples.optJSONObject(i);
            if (sample == null) continue;
            String stage = sample.optString("stage", "");
            if ("completed".equals(stage)) completed++;
            else if ("failed".equals(stage)) failed++;
            else if ("teardown".equals(stage)) teardown++;
            if (sample.optBoolean("audible_success", false)) audible++;
            long latency = sample.optLong("commit_to_terminal_ms", -1L);
            if (latency >= 0L) latencies.add(latency);
            long firstFeedback = sample.optLong("capture_to_first_feedback_ms", -1L);
            if (firstFeedback >= 0L) firstFeedbackLatencies.add(firstFeedback);
        }
        int total = completed + failed + teardown;
        if (total == 0) return "No mobile voice samples yet";
        Collections.sort(latencies);
        return total + " turns · " + completed + " completed · " + failed + " failed · "
                + teardown + " canceled · audible " + audible + " · p50 "
                + percentile(latencies, 0.50) + " ms · p95 " + percentile(latencies, 0.95) + " ms"
                + " · first feedback p50 " + percentile(firstFeedbackLatencies, 0.50)
                + " ms · p95 " + percentile(firstFeedbackLatencies, 0.95) + " ms";
    }

    private static JSONArray load(SharedPreferences prefs) {
        try {
            return new JSONArray(prefs.getString(KEY, "[]"));
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    static void appendBounded(JSONArray samples, JSONObject sample) {
        synchronized (STORE_LOCK) {
            samples.put(sample);
            while (samples.length() > MAX_SAMPLES) samples.remove(0);
        }
    }

    private static long boundedDuration(long value) {
        return value < 0L ? -1L : Math.min(value, 600000L);
    }

    private static long percentile(List<Long> values, double percentile) {
        if (values.isEmpty()) return -1L;
        int index = (int) Math.ceil(percentile * values.size()) - 1;
        return values.get(Math.max(0, Math.min(index, values.size() - 1)));
    }
}
