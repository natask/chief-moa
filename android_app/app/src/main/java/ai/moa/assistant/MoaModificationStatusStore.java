package ai.moa.assistant;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

/** Durable local cache of the last truthfully parsed modification status. */
final class MoaModificationStatusStore {
    private static final String PREFS = "moa_modification_status_v1";
    private static final String KEY = "latest";
    private final SharedPreferences prefs;

    MoaModificationStatusStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    void save(MoaModificationRequestPolicy.Status status) throws Exception {
        if (status == null) throw new IllegalArgumentException("status is required");
        if (!prefs.edit().putString(KEY, status.toJson().toString()).commit()) {
            throw new IllegalStateException("modification status could not be persisted");
        }
    }

    MoaModificationRequestPolicy.Status load() {
        String raw = prefs.getString(KEY, "");
        if (raw == null || raw.isEmpty()) return null;
        try {
            return MoaModificationRequestPolicy.parseStored(new JSONObject(raw));
        } catch (Exception error) {
            return null;
        }
    }
}
