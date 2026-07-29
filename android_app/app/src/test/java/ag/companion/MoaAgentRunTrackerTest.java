package ag.companion;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaAgentRunTrackerTest {
    @Test
    public void tracksEveryGatewayResponseShapeAndRefreshesExistingState() throws Exception {
        MoaAgentRunTracker tracker = new MoaAgentRunTracker();
        tracker.trackResponse(null);
        tracker.track(null);
        tracker.track(new JSONObject().put("id", "   "));
        assertFalse(tracker.hasRuns());

        tracker.trackResponse(new JSONObject()
                .put("run", run("run-1", "queued", true, "codex", ""))
                .put("agent_run", run("run-2", "running", true, "gemini", "working"))
                .put("agent_runs", new JSONArray()
                        .put(run("run-3", "paused", false, "claude", "waiting"))
                        .put("not-an-object")
                        .put(run("run-4", "running", true, "codex", "four"))));

        assertTrue(tracker.hasRuns());
        assertEquals(4, tracker.ids().size());
        assertEquals("run-4", tracker.activeFollowUpRunId());
        assertEquals("3 runs active", tracker.statusText());

        tracker.track(new JSONObject()
                .put("id", "run-3")
                .put("status", "running")
                .put("output_preview", "resumed"));
        assertEquals("run-3", tracker.activeFollowUpRunId());
        assertEquals("4 runs active", tracker.statusText());
    }

    @Test
    public void trackDefaultsActivityFromStatusUnlessGatewayOverridesIt() throws Exception {
        MoaAgentRunTracker tracker = new MoaAgentRunTracker();
        tracker.track(new JSONObject().put("id", "blank-status"));
        tracker.track(new JSONObject().put("id", "queued").put("status", "queued"));
        tracker.track(new JSONObject().put("id", "running").put("status", "running"));
        tracker.track(new JSONObject().put("id", "paused").put("status", "paused"));
        tracker.track(new JSONObject()
                .put("id", "override")
                .put("status", "paused")
                .put("active", true));

        assertEquals("4 runs active", tracker.statusText());
    }

    @Test
    public void createsPollAndFailureUpdatesWithoutTrustingResponseIdentity() throws Exception {
        MoaAgentRunTracker.State empty = MoaAgentRunTracker.pollUpdate(" requested ", null);
        assertEquals("requested", empty.id);
        assertEquals("queued", empty.status);

        MoaAgentRunTracker.State update = MoaAgentRunTracker.pollUpdate(
                "requested",
                new JSONObject()
                        .put("id", "untrusted-other-id")
                        .put("harness", " codex ")
                        .put("status", "completed")
                        .put("output_preview", " done ")
        );
        assertEquals("requested", update.id);
        assertEquals("codex", update.harness);
        assertEquals("completed", update.status);
        assertEquals("done", update.outputPreview);
        assertFalse(update.active);

        MoaAgentRunTracker.State explicit = MoaAgentRunTracker.pollUpdate(
                "explicit",
                new JSONObject().put("status", "completed").put("active", true)
        );
        assertTrue(explicit.active);

        MoaAgentRunTracker.State failure = MoaAgentRunTracker.failedPollUpdate("run-fail", " timeout ");
        assertEquals("unknown", failure.status);
        assertEquals("timeout", failure.outputPreview);
        assertFalse(failure.active);
        assertEquals("", MoaAgentRunTracker.failedPollUpdate(null, null).id);
    }

    @Test
    public void appliesPartialUpdatesAndReturnsTerminalCompletionCopy() throws Exception {
        MoaAgentRunTracker tracker = new MoaAgentRunTracker();
        tracker.track(run("short", "running", true, "codex", "old"));

        assertTrue(tracker.applyUpdates(null).isEmpty());
        assertTrue(tracker.applyUpdates(Arrays.asList(
                null,
                MoaAgentRunTracker.pollUpdate("missing", new JSONObject().put("status", "completed"))
        )).isEmpty());

        MoaAgentRunTracker.State partial = new MoaAgentRunTracker.State("short");
        partial.harness = "";
        partial.status = "";
        partial.outputPreview = "new";
        partial.active = false;
        assertTrue(tracker.applyUpdates(Collections.singletonList(partial)).isEmpty());
        assertTrue(tracker.hasRuns());
        assertEquals("1 run active", tracker.statusText());

        MoaAgentRunTracker.State complete = MoaAgentRunTracker.pollUpdate(
                "short",
                new JSONObject().put("status", "completed").put("output_preview", "finished")
        );
        List<String> completions = tracker.applyUpdates(Collections.singletonList(complete));
        assertEquals(Collections.singletonList("Run short completed.\nfinished"), completions);
        assertFalse(tracker.hasRuns());
        assertEquals("Ready", tracker.statusText());
        assertEquals("", tracker.activeFollowUpRunId());
    }

    @Test
    public void fallsBackToAnotherRunWhenTheMostRecentRunCompletes() throws Exception {
        MoaAgentRunTracker tracker = new MoaAgentRunTracker();
        tracker.track(run("older", "paused", false, "", ""));
        tracker.track(run("newer", "running", true, "", ""));

        tracker.applyUpdates(Collections.singletonList(MoaAgentRunTracker.pollUpdate(
                "newer",
                new JSONObject().put("status", "failed")
        )));

        assertEquals("older", tracker.activeFollowUpRunId());
        assertEquals("1 run active", tracker.statusText());
    }

    @Test
    public void usesAllRunsAsStatusFallbackWhenNoneAreMarkedActive() throws Exception {
        MoaAgentRunTracker tracker = new MoaAgentRunTracker();
        tracker.track(run("one", "paused", false, "", ""));
        tracker.track(run("two", "waiting", false, "", ""));
        assertEquals("2 runs active", tracker.statusText());
    }

    @Test
    public void followUpBindingNeverCapturesARunFromAnotherSessionOrBranch() throws Exception {
        MoaAgentRunTracker tracker = new MoaAgentRunTracker();
        tracker.track(scopedRun("run-a", "session-a", "branch-a", "intent-a"));
        tracker.track(scopedRun("run-b", "session-a", "branch-b", "intent-b"));
        tracker.track(scopedRun("run-c", "session-c", "branch-a", "intent-c"));

        MoaAgentRunTracker.FollowUpResolution resolved =
                tracker.resolveFollowUp("session-a", "branch-a");
        assertEquals(MoaAgentRunTracker.FollowUpResolution.Kind.BOUND, resolved.kind);
        assertEquals("run-a", resolved.runId);
        assertEquals("intent-a", resolved.intentId);
        assertEquals("intent-a", tracker.intentIdForRun("run-a"));
        assertEquals("", tracker.intentIdForRun("missing"));

        assertEquals(MoaAgentRunTracker.FollowUpResolution.Kind.NONE,
                tracker.resolveFollowUp("session-a", "missing").kind);
    }

    @Test
    public void concurrentDifferentIntentsAreExplicitlyAmbiguous() throws Exception {
        MoaAgentRunTracker tracker = new MoaAgentRunTracker();
        tracker.track(scopedRun("run-a1", "session-a", "branch-a", "intent-a"));
        tracker.track(scopedRun("run-b1", "session-a", "branch-a", "intent-b"));

        MoaAgentRunTracker.FollowUpResolution resolved =
                tracker.resolveFollowUp("session-a", "branch-a");
        assertEquals(MoaAgentRunTracker.FollowUpResolution.Kind.AMBIGUOUS, resolved.kind);
        assertEquals("", resolved.runId);
        assertEquals(2, resolved.candidateCount);
    }

    @Test
    public void concurrentRunsForOneIntentContinueItsMostRecentRun() throws Exception {
        MoaAgentRunTracker tracker = new MoaAgentRunTracker();
        tracker.track(scopedRun("run-old", "session-a", "branch-a", "intent-a"));
        tracker.track(scopedRun("run-new", "session-a", "branch-a", "intent-a"));

        MoaAgentRunTracker.FollowUpResolution resolved =
                tracker.resolveFollowUp("session-a", "branch-a");
        assertEquals(MoaAgentRunTracker.FollowUpResolution.Kind.BOUND, resolved.kind);
        assertEquals("run-new", resolved.runId);
        assertEquals("intent-a", resolved.intentId);
    }

    @Test
    public void completionTextBoundsIdentifiersAndOmitsBlankPreview() {
        MoaAgentRunTracker.State longId = new MoaAgentRunTracker.State("12345678901");
        longId.status = "canceled";
        assertEquals("Run 1234567890 canceled.", MoaAgentRunTracker.completionText(longId));

        longId.outputPreview = "receipt";
        assertEquals("Run 1234567890 canceled.\nreceipt", MoaAgentRunTracker.completionText(longId));
    }

    @Test
    public void classifiesEveryActiveAndTerminalStatus() {
        assertTrue(MoaAgentRunTracker.isActiveStatus(null));
        assertTrue(MoaAgentRunTracker.isActiveStatus("  "));
        assertTrue(MoaAgentRunTracker.isActiveStatus("queued"));
        assertTrue(MoaAgentRunTracker.isActiveStatus("running"));
        assertFalse(MoaAgentRunTracker.isActiveStatus("completed"));

        for (String status : new String[]{
                "completed", "failed", "timed-out", "timed_out", "timeout", "canceled", "unknown"
        }) {
            assertTrue(status, MoaAgentRunTracker.isTerminalStatus(status));
        }
        assertFalse(MoaAgentRunTracker.isTerminalStatus(null));
        assertFalse(MoaAgentRunTracker.isTerminalStatus("running"));
    }

    private static JSONObject run(
            String id,
            String status,
            boolean active,
            String harness,
            String output
    ) throws Exception {
        return new JSONObject()
                .put("id", id)
                .put("status", status)
                .put("active", active)
                .put("harness", harness)
                .put("output_preview", output);
    }

    private static JSONObject scopedRun(
            String id,
            String sessionId,
            String branchId,
            String intentId
    ) throws Exception {
        return run(id, "running", true, "codex", "")
                .put("conversation_id", sessionId)
                .put("branch_id", branchId)
                .put("intent_id", intentId);
    }
}
