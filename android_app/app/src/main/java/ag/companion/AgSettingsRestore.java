package ag.companion;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Applies gateway-owned settings to a freshly installed {@code ag.companion}.
 *
 * <p>Android sandboxing means this package cannot read {@code ai.moa.assistant}'s
 * app-private storage. Continuity therefore comes from the account, not from a
 * local migration: the device authenticates, reads its settings, and merges
 * them over whatever it already holds.</p>
 *
 * <p>Schema migration ships with the release. {@link #CLIENT_SCHEMA_VERSION} is
 * this build's understanding of the settings shape and {@link #MIGRATIONS} are
 * the upgrade steps it carries. A snapshot from an older schema is replayed
 * forward before it is applied. A snapshot from a newer schema is applied as-is
 * and reported as partial — the client never discards a setting it does not
 * recognize, because the account, not the device, still owns it.</p>
 */
final class AgSettingsRestore {
    static final int CLIENT_SCHEMA_VERSION = 1;

    /**
     * Forward upgrade steps this release carries, ordered by the schema version
     * they produce. Empty at version 1: there is no prior shipped shape to
     * upgrade from. Renames are added here — never applied silently elsewhere —
     * so a rename always travels with the release that introduces it.
     */
    static final List<Migration> MIGRATIONS = Collections.unmodifiableList(new ArrayList<>());

    enum Status {
        /** The snapshot matched or was upgraded to this build's schema. */
        RESTORED,
        /** Applied, but the server schema is newer than this build understands. */
        RESTORED_PARTIAL,
        /** Nothing was changed; the stored settings are untouched. */
        REJECTED
    }

    private AgSettingsRestore() {
    }

    static Result apply(String storedSettingsJson, JSONObject payload) {
        if (payload == null) {
            return rejected(storedSettingsJson, "no settings snapshot was returned");
        }
        if (payload.optBoolean("local_state_transferred", true)) {
            return rejected(storedSettingsJson, "snapshot claimed a local-state transfer");
        }
        int serverVersion = payload.optInt("settings_schema_version", 0);
        if (serverVersion < 1) {
            return rejected(storedSettingsJson, "snapshot did not name a settings schema version");
        }
        JSONObject settings = payload.optJSONObject("settings");
        if (settings == null) {
            return rejected(storedSettingsJson, "snapshot carried no settings");
        }
        JSONObject upgraded = migrate(settings, serverVersion, CLIENT_SCHEMA_VERSION, MIGRATIONS);
        JSONObject merged = merge(parse(storedSettingsJson), upgraded);
        boolean partial = serverVersion > CLIENT_SCHEMA_VERSION;
        return new Result(
                partial ? Status.RESTORED_PARTIAL : Status.RESTORED,
                merged.toString(),
                serverVersion,
                partial
                        ? "Your account uses newer settings than this version of Ag. They were kept, "
                                + "and update Ag to apply all of them."
                        : "",
                keys(upgraded));
    }

    /**
     * Replay the upgrade steps between two schema versions. Steps whose target
     * version is at or below {@code fromVersion}, or above {@code toVersion},
     * are skipped, so a client only runs the migrations it has not already seen.
     */
    static JSONObject migrate(JSONObject settings, int fromVersion, int toVersion, List<Migration> steps) {
        JSONObject current = copy(settings);
        if (steps == null || fromVersion >= toVersion) {
            return current;
        }
        for (Migration step : steps) {
            if (step == null || step.toVersion <= fromVersion || step.toVersion > toVersion) {
                continue;
            }
            current = step.apply(current);
        }
        return current;
    }

    /**
     * Overlay the snapshot on the stored settings. An empty or blank incoming
     * value never replaces a stored one, and stored keys the snapshot omits stay
     * put, so a restore can only add or correct — never quietly erase.
     */
    private static JSONObject merge(JSONObject stored, JSONObject incoming) {
        JSONObject merged = copy(stored);
        for (String key : keys(incoming)) {
            Object value = incoming.opt(key);
            if (value == null || (value instanceof String && ((String) value).trim().isEmpty())) {
                continue;
            }
            try {
                merged.put(key, value);
            } catch (Exception ignored) {
                // A key that cannot be written is left at its stored value.
            }
        }
        return merged;
    }

    private static Result rejected(String storedSettingsJson, String reason) {
        return new Result(Status.REJECTED, parse(storedSettingsJson).toString(), 0,
                "Settings were not restored: " + reason + ".", Collections.emptyList());
    }

    private static JSONObject parse(String json) {
        if (json == null || json.trim().isEmpty()) {
            return new JSONObject();
        }
        try {
            return new JSONObject(json);
        } catch (Exception error) {
            return new JSONObject();
        }
    }

    private static JSONObject copy(JSONObject source) {
        JSONObject result = new JSONObject();
        if (source == null) {
            return result;
        }
        for (String key : keys(source)) {
            try {
                result.put(key, source.opt(key));
            } catch (Exception ignored) {
                // Skip a key that cannot be copied rather than fail the restore.
            }
        }
        return result;
    }

    private static List<String> keys(JSONObject source) {
        List<String> result = new ArrayList<>();
        if (source == null) {
            return result;
        }
        for (Iterator<String> it = source.keys(); it.hasNext(); ) {
            result.add(it.next());
        }
        return result;
    }

    /** One shipped upgrade step: field renames that produce {@code toVersion}. */
    static final class Migration {
        final int toVersion;
        private final Map<String, String> renames;

        Migration(int toVersion, Map<String, String> renames) {
            this.toVersion = toVersion;
            this.renames = new LinkedHashMap<>(renames == null ? Collections.emptyMap() : renames);
        }

        JSONObject apply(JSONObject settings) {
            JSONObject result = copy(settings);
            for (Map.Entry<String, String> rename : renames.entrySet()) {
                if (!result.has(rename.getKey())) {
                    continue;
                }
                Object value = result.remove(rename.getKey());
                String target = rename.getValue();
                if (target == null || target.trim().isEmpty()) {
                    continue;
                }
                try {
                    result.put(target, value);
                } catch (Exception ignored) {
                    // Leave the field dropped rather than write an invalid key.
                }
            }
            return result;
        }
    }

    static final class Result {
        final Status status;
        final String settingsJson;
        final int serverSchemaVersion;
        final String note;
        final List<String> appliedFields;

        Result(Status status, String settingsJson, int serverSchemaVersion, String note,
                List<String> appliedFields) {
            this.status = status;
            this.settingsJson = settingsJson;
            this.serverSchemaVersion = serverSchemaVersion;
            this.note = note;
            this.appliedFields = Collections.unmodifiableList(new ArrayList<>(appliedFields));
        }

        boolean restored() {
            return status != Status.REJECTED;
        }
    }
}
