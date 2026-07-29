package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Bounded Android read model for gateway-owned canonical intents. */
final class MoaIntentPortfolio {
    static final int MAX_INTENTS = 30;

    final List<Item> items;
    final boolean truncated;

    private MoaIntentPortfolio(List<Item> items, boolean truncated) {
        this.items = Collections.unmodifiableList(items);
        this.truncated = truncated;
    }

    static MoaIntentPortfolio from(JSONObject payload) {
        JSONArray rows = payload == null ? null : payload.optJSONArray("items");
        List<Item> items = new ArrayList<>();
        if (rows != null) {
            for (int index = 0; index < rows.length() && items.size() < MAX_INTENTS; index++) {
                JSONObject row = rows.optJSONObject(index);
                if (row == null) continue;
                String id = text(row.optString("intent_id", ""), 160);
                if (id.isEmpty()) continue;
                String objective = text(row.optString("normalized_objective", row.optString("statement", "")), 500);
                String lifecycle = text(row.optString("lifecycle_state", "captured"), 40);
                String nextStep = text(row.optString("next_step", ""), 500);
                JSONArray blockers = row.optJSONArray("blockers");
                JSONArray runRefs = row.optJSONArray("run_refs");
                items.add(new Item(
                        id,
                        objective.isEmpty() ? id : objective,
                        lifecycle.isEmpty() ? "captured" : lifecycle,
                        nextStep,
                        blockers == null ? 0 : blockers.length(),
                        runRefs == null ? 0 : runRefs.length(),
                        text(row.optString("updated_at", ""), 80)));
            }
        }
        JSONObject truncation = payload == null ? null : payload.optJSONObject("truncation");
        return new MoaIntentPortfolio(items, truncation != null && truncation.optBoolean("truncated", false));
    }

    int activeCount() {
        int count = 0;
        for (Item item : items) {
            if ("active".equals(item.lifecycle) || "planned".equals(item.lifecycle)
                    || "waiting".equals(item.lifecycle) || "blocked".equals(item.lifecycle)) count++;
        }
        return count;
    }

    private static String text(String value, int maxLength) {
        String safe = value == null ? "" : value.trim();
        return safe.length() <= maxLength ? safe : safe.substring(0, maxLength);
    }

    static final class Item {
        final String id;
        final String objective;
        final String lifecycle;
        final String nextStep;
        final int blockerCount;
        final int runCount;
        final String updatedAt;

        Item(String id, String objective, String lifecycle, String nextStep,
             int blockerCount, int runCount, String updatedAt) {
            this.id = id;
            this.objective = objective;
            this.lifecycle = lifecycle;
            this.nextStep = nextStep;
            this.blockerCount = blockerCount;
            this.runCount = runCount;
            this.updatedAt = updatedAt;
        }

        String metadataLine() {
            StringBuilder value = new StringBuilder(lifecycle.toUpperCase());
            if (blockerCount > 0) value.append(" · ").append(blockerCount).append(" blocker").append(blockerCount == 1 ? "" : "s");
            if (runCount > 0) value.append(" · ").append(runCount).append(" run").append(runCount == 1 ? "" : "s");
            return value.toString();
        }
    }
}
