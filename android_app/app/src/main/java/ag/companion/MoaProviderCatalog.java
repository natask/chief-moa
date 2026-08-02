package ag.companion;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Gateway-owned provider choices rendered by the Android full app. */
final class MoaProviderCatalog {
    static final class Choice {
        final String id;
        final String label;
        final String status;
        final String modelId;
        final String explanation;
        final boolean configured;
        final boolean active;

        Choice(String id, String label, String status, String modelId, String explanation,
                boolean configured, boolean active) {
            this.id = safe(id);
            this.label = safe(label);
            this.status = safe(status);
            this.modelId = safe(modelId);
            this.explanation = safe(explanation);
            this.configured = configured;
            this.active = active;
        }

        String statusText() {
            if (active) return "Active" + modelSuffix();
            if (configured) return "Ready" + modelSuffix();
            String state = "unavailable".equals(status) ? "Unavailable" : "Not configured";
            return explanation.isEmpty() ? state : state + " · " + explanation;
        }

        private String modelSuffix() {
            return modelId.isEmpty() ? "" : " · " + modelId;
        }
    }

    final List<Choice> choices;
    final String activeChoiceId;
    final String profileVersion;

    private MoaProviderCatalog(List<Choice> choices, String activeChoiceId, String profileVersion) {
        this.choices = Collections.unmodifiableList(choices);
        this.activeChoiceId = safe(activeChoiceId);
        this.profileVersion = safe(profileVersion);
    }

    static MoaProviderCatalog parse(JSONObject catalogPayload, JSONObject profilePayload) {
        JSONObject active = catalogPayload == null ? null : catalogPayload.optJSONObject("active_selection");
        String activeId = active == null ? "" : safe(active.optString("choice_id", ""));
        JSONArray items = catalogPayload == null ? null : catalogPayload.optJSONArray("choices");
        List<Choice> choices = new ArrayList<>();
        for (int i = 0; items != null && i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            String id = safe(item.optString("id", ""));
            if (id.isEmpty()) continue;
            choices.add(new Choice(
                    id,
                    safe(item.optString("label", id)),
                    safe(item.optString("status", "unavailable")),
                    defaultModel(item.optJSONArray("models")),
                    explanation(item),
                    item.optBoolean("configured", false) && item.optBoolean("available", false),
                    id.equals(activeId)));
        }
        return new MoaProviderCatalog(choices, activeId, profileVersion(profilePayload));
    }

    static String profileVersion(JSONObject payload) {
        if (payload == null) return "";
        String value = safe(payload.optString("profile_version", ""));
        return value.isEmpty() ? safe(payload.optString("current_version", "")) : value;
    }

    static boolean confirmsNewVersion(String oldVersion, JSONObject response) {
        String next = profileVersion(response);
        return !next.isEmpty() && !next.equals(safe(oldVersion));
    }

    private static String defaultModel(JSONArray models) {
        String first = "";
        for (int i = 0; models != null && i < models.length(); i++) {
            JSONObject model = models.optJSONObject(i);
            if (model == null) continue;
            String id = safe(model.optString("id", ""));
            if (first.isEmpty()) first = id;
            if (!id.isEmpty() && model.optBoolean("default", false)) return id;
        }
        return first;
    }

    private static String explanation(JSONObject item) {
        JSONArray issues = item.optJSONArray("issues");
        for (int i = 0; issues != null && i < issues.length(); i++) {
            String issue = safe(issues.optString(i, ""));
            if (!issue.isEmpty()) return issue;
        }
        return safe(item.optString("limitation", ""));
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}
