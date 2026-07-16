package ai.moa.assistant;

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
        boolean active = true;

        State(String id) {
            this.id = safe(id);
        }
    }
}
