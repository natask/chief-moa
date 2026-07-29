package ag.companion;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Pure in-memory coordinator for agent-run summaries shown by the Android
 * surface. Network polling and UI rendering remain owned by OverlayService.
 */
final class MoaAgentRunTracker {
    private final Map<String, State> runs = new HashMap<>();
    private String lastActiveRunId = "";

    void trackResponse(JSONObject response) {
        if (response == null) {
            return;
        }
        track(response.optJSONObject("run"));
        track(response.optJSONObject("agent_run"));

        JSONArray items = response.optJSONArray("agent_runs");
        if (items == null) {
            return;
        }
        for (int index = 0; index < items.length(); index++) {
            track(items.optJSONObject(index));
        }
    }

    void track(JSONObject run) {
        if (run == null) {
            return;
        }
        String id = safe(run.optString("id", ""));
        if (id.isEmpty()) {
            return;
        }

        State state = runs.get(id);
        if (state == null) {
            state = new State(id);
            runs.put(id, state);
        }
        lastActiveRunId = id;
        state.harness = safe(run.optString("harness", state.harness));
        state.status = safe(run.optString("status", state.status));
        state.outputPreview = safe(run.optString("output_preview", state.outputPreview));
        state.sessionId = safe(run.optString("conversation_id",
                run.optString("session_id", state.sessionId)));
        state.branchId = safe(run.optString("branch_id", state.branchId));
        state.intentId = safe(run.optString("intent_id", state.intentId));
        state.active = run.optBoolean("active", isActiveStatus(state.status));
    }

    static State pollUpdate(String requestedId, JSONObject run) {
        State state = new State(requestedId);
        if (run == null) {
            return state;
        }
        state.harness = safe(run.optString("harness", ""));
        state.status = safe(run.optString("status", ""));
        state.outputPreview = safe(run.optString("output_preview", ""));
        state.sessionId = safe(run.optString("conversation_id", run.optString("session_id", "")));
        state.branchId = safe(run.optString("branch_id", ""));
        state.intentId = safe(run.optString("intent_id", ""));
        state.active = run.optBoolean("active", isActiveStatus(state.status));
        return state;
    }

    static State failedPollUpdate(String requestedId, String error) {
        State state = new State(requestedId);
        state.status = "unknown";
        state.outputPreview = safe(error);
        state.active = false;
        return state;
    }

    List<String> applyUpdates(List<State> updates) {
        List<String> completions = new ArrayList<>();
        if (updates == null) {
            return completions;
        }
        for (State update : updates) {
            if (update == null) {
                continue;
            }
            State previous = runs.get(update.id);
            if (previous == null) {
                continue;
            }
            previous.harness = update.harness.isEmpty() ? previous.harness : update.harness;
            previous.status = update.status.isEmpty() ? previous.status : update.status;
            previous.outputPreview = update.outputPreview;
            previous.active = update.active;
            if (isTerminalStatus(previous.status)) {
                completions.add(completionText(previous));
                runs.remove(previous.id);
            }
        }
        return completions;
    }

    boolean hasRuns() {
        return !runs.isEmpty();
    }

    List<String> ids() {
        return new ArrayList<>(runs.keySet());
    }

    String activeFollowUpRunId() {
        if (!lastActiveRunId.isEmpty() && runs.containsKey(lastActiveRunId)) {
            return lastActiveRunId;
        }
        for (String id : runs.keySet()) {
            return id;
        }
        return "";
    }

    String intentIdForRun(String runId) {
        State state = runs.get(safe(runId));
        return state == null ? "" : state.intentId;
    }

    FollowUpResolution resolveFollowUp(String sessionId, String branchId) {
        String session = safe(sessionId);
        String branch = safe(branchId);
        List<State> matches = new ArrayList<>();
        for (State state : runs.values()) {
            if (!isActiveStatus(state.status) && !state.active) {
                continue;
            }
            if (!session.equals(state.sessionId) || !branch.equals(state.branchId)) {
                continue;
            }
            matches.add(state);
        }
        if (matches.isEmpty()) {
            return FollowUpResolution.none();
        }
        if (matches.size() == 1) {
            return FollowUpResolution.bound(matches.get(0).id, matches.get(0).intentId);
        }
        String commonIntent = matches.get(0).intentId;
        boolean oneIntent = !commonIntent.isEmpty();
        for (State state : matches) {
            if (!commonIntent.equals(state.intentId)) {
                oneIntent = false;
                break;
            }
        }
        if (oneIntent) {
            State newest = matches.get(0);
            for (State state : matches) {
                if (state.id.equals(lastActiveRunId)) {
                    newest = state;
                    break;
                }
            }
            return FollowUpResolution.bound(newest.id, commonIntent);
        }
        return FollowUpResolution.ambiguous(matches.size());
    }

    String statusText() {
        if (runs.isEmpty()) {
            return "Ready";
        }
        int running = 0;
        for (State state : runs.values()) {
            if (state.active || isActiveStatus(state.status)) {
                running++;
            }
        }
        int count = running > 0 ? running : runs.size();
        return count == 1 ? "1 run active" : count + " runs active";
    }

    static String completionText(State state) {
        String id = state.id.length() > 10 ? state.id.substring(0, 10) : state.id;
        String base = "Run " + id + " " + state.status + ".";
        return state.outputPreview.isEmpty() ? base : base + "\n" + state.outputPreview;
    }

    static boolean isActiveStatus(String status) {
        String value = safe(status);
        return value.isEmpty() || "queued".equals(value) || "running".equals(value);
    }

    static boolean isTerminalStatus(String status) {
        String value = safe(status);
        return "completed".equals(value)
                || "failed".equals(value)
                || "timed-out".equals(value)
                || "timed_out".equals(value)
                || "timeout".equals(value)
                || "canceled".equals(value)
                || "unknown".equals(value);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    static final class State {
        final String id;
        String harness = "";
        String status = "queued";
        String outputPreview = "";
        String sessionId = "";
        String branchId = "";
        String intentId = "";
        boolean active = true;

        State(String id) {
            this.id = safe(id);
        }
    }

    static final class FollowUpResolution {
        enum Kind { NONE, BOUND, AMBIGUOUS }

        final Kind kind;
        final String runId;
        final String intentId;
        final int candidateCount;

        private FollowUpResolution(Kind kind, String runId, String intentId, int candidateCount) {
            this.kind = kind;
            this.runId = safe(runId);
            this.intentId = safe(intentId);
            this.candidateCount = candidateCount;
        }

        static FollowUpResolution none() {
            return new FollowUpResolution(Kind.NONE, "", "", 0);
        }

        static FollowUpResolution bound(String runId, String intentId) {
            return new FollowUpResolution(Kind.BOUND, runId, intentId, 1);
        }

        static FollowUpResolution ambiguous(int candidateCount) {
            return new FollowUpResolution(Kind.AMBIGUOUS, "", "", candidateCount);
        }
    }
}
