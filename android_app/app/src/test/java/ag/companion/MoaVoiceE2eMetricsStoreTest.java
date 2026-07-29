package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

public final class MoaVoiceE2eMetricsStoreTest {
    @Test
    public void summaryReportsRollingOutcomeAndLatencyEvidence() throws Exception {
        JSONArray samples = new JSONArray()
                .put(sample("completed", true, 100))
                .put(sample("completed", false, 200))
                .put(sample("failed", false, 300))
                .put(sample("teardown", false, 400));

        String summary = MoaVoiceE2eMetricsStore.summary(samples);

        assertTrue(summary.contains("4 turns"));
        assertTrue(summary.contains("2 completed"));
        assertTrue(summary.contains("1 failed"));
        assertTrue(summary.contains("1 canceled"));
        assertTrue(summary.contains("audible 1"));
        assertTrue(summary.contains("p50 200 ms"));
        assertTrue(summary.contains("p95 400 ms"));
        assertFalse(summary.contains("transcript"));
    }

    @Test
    public void emptySummaryIsExplicit() {
        assertEquals("No mobile voice samples yet",
                MoaVoiceE2eMetricsStore.summary(new JSONArray()));
    }

    @Test
    public void concurrentAppendsKeepEverySampleUpToRetentionBound() throws Exception {
        JSONArray samples = new JSONArray();
        List<Thread> workers = new ArrayList<>();
        for (int i = 0; i < 80; i++) {
            final int value = i;
            Thread worker = new Thread(() -> {
                try {
                    MoaVoiceE2eMetricsStore.appendBounded(
                            samples,
                            new JSONObject().put("value", value));
                } catch (Exception error) {
                    throw new AssertionError(error);
                }
            });
            workers.add(worker);
            worker.start();
        }
        for (Thread worker : workers) worker.join();

        assertEquals(80, samples.length());
    }

    private static JSONObject sample(String stage, boolean audible, long latency)
            throws Exception {
        return new JSONObject()
                .put("stage", stage)
                .put("audible_success", audible)
                .put("commit_to_terminal_ms", latency);
    }
}
