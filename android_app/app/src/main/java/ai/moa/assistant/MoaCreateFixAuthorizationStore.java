package ai.moa.assistant;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

/** Persists the exact Create fix authorization so a lost response can be retried safely. */
final class MoaCreateFixAuthorizationStore {
    private static final String PREFS = "moa_create_fix_authorization_v1";
    private static final String KEY = "pending";
    private final SharedPreferences prefs;

    MoaCreateFixAuthorizationStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    MoaCreateFixAuthorization load() {
        String raw = prefs.getString(KEY, "");
        if (raw == null || raw.isEmpty()) return null;
        try {
            return MoaCreateFixAuthorization.fromJson(new JSONObject(raw));
        } catch (Exception error) {
            return null;
        }
    }

    void save(MoaCreateFixAuthorization authorization) throws Exception {
        if (authorization == null) throw new IllegalArgumentException("authorization is required");
        if (!prefs.edit().putString(KEY, authorization.toJson().toString()).commit()) {
            throw new IllegalStateException("Create fix authorization could not be persisted");
        }
    }
}
