package ai.moa.assistant;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Durable, owner-scoped intent to converge an approved gateway bookmark delete. */
final class MoaMediaDeleteJournal {
    static final int MAX_RECORDS = 200;
    private static final String PREFS = "moa_media_delete_journal";
    private static final String KEY = "pending_json";
    private static final String SYNC_KEY = "pending_sync_json";
    private final SharedPreferences preferences;

    MoaMediaDeleteJournal(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized boolean put(String localId, String gatewayId) {
        return put(localId, gatewayId, "");
    }

    synchronized boolean put(String localId, String gatewayId, String videoId) {
        if (!healthy()) return false;
        Entry entry = new Entry(localId, gatewayId, videoId);
        if (!entry.valid()) return false;
        List<Entry> entries = new ArrayList<>(all());
        entries.removeIf(item -> item.key().equals(entry.key()));
        if (entries.size() >= MAX_RECORDS) return false;
        entries.add(entry);
        return preferences.edit().putString(KEY, serialize(entries)).commit();
    }

    synchronized boolean remove(String localId, String gatewayId) {
        if (!healthy()) return false;
        String key = new Entry(localId, gatewayId, "").key();
        List<Entry> entries = new ArrayList<>(all());
        boolean changed = entries.removeIf(item -> item.key().equals(key));
        return !changed || preferences.edit().putString(KEY, serialize(entries)).commit();
    }

    synchronized List<Entry> all() {
        return deserialize(preferences.getString(KEY, ""));
    }

    synchronized boolean containsGatewayId(String gatewayId) {
        for (Entry entry : all()) if (entry.gatewayId.equals(gatewayId)) return true;
        return false;
    }

    synchronized boolean containsLocalDelete(String localId) {
        for (Entry entry : all()) if (entry.localId.equals(localId)) return true;
        return false;
    }

    synchronized boolean containsVideoId(String videoId) {
        return containsVideoId(all(), videoId);
    }

    static boolean containsVideoId(List<Entry> entries, String videoId) {
        for (Entry entry : entries) if (!entry.videoId.isEmpty() && entry.videoId.equals(videoId)) return true;
        return false;
    }

    synchronized boolean putPendingSync(String localId) {
        if (!healthy() || !localId.matches("[A-Za-z0-9_-]{1,200}")) return false;
        List<String> ids = pendingSyncIds();
        if (!canReserveSync(ids, localId)) return false;
        if (!ids.contains(localId)) ids.add(localId);
        return preferences.edit().putString(SYNC_KEY, new JSONArray(ids).toString()).commit();
    }

    synchronized void removePendingSync(String localId) {
        List<String> ids = pendingSyncIds();
        if (ids.remove(localId)) preferences.edit()
                .putString(SYNC_KEY, new JSONArray(ids).toString()).commit();
    }

    synchronized List<String> pendingSyncIds() {
        List<String> result = new ArrayList<>();
        try {
            JSONArray values = new JSONArray(preferences.getString(SYNC_KEY, "[]"));
            for (int i = 0; i < Math.min(values.length(), 200); i++) {
                String id = values.optString(i, "");
                if (id.matches("[A-Za-z0-9_-]{1,200}") && !result.contains(id)) result.add(id);
            }
        } catch (Exception ignored) {
        }
        return result;
    }

    synchronized boolean healthy() {
        return isStateHealthy(preferences.getString(KEY, ""),
                preferences.getString(SYNC_KEY, "[]"));
    }

    static boolean isStateHealthy(String deletes, String syncs) {
        try {
            JSONArray deleteValues = new JSONArray(deletes == null || deletes.isBlank() ? "[]" : deletes);
            JSONArray syncValues = new JSONArray(syncs == null || syncs.isBlank() ? "[]" : syncs);
            if (deleteValues.length() > MAX_RECORDS || syncValues.length() > MAX_RECORDS) return false;
            for (int i = 0; i < deleteValues.length(); i++) {
                JSONObject value = deleteValues.optJSONObject(i);
                if (value == null || !new Entry(value.optString("local_id", ""),
                        value.optString("gateway_id", ""), value.optString("video_id", "")).valid()) return false;
            }
            for (int i = 0; i < syncValues.length(); i++) {
                if (!syncValues.optString(i, "").matches("[A-Za-z0-9_-]{1,200}")) return false;
            }
            return true;
        } catch (Exception invalid) { return false; }
    }

    static boolean canReserveSync(List<String> ids, String localId) {
        return localId != null && localId.matches("[A-Za-z0-9_-]{1,200}")
                && (ids.contains(localId) || ids.size() < MAX_RECORDS);
    }

    static String serialize(List<Entry> entries) {
        JSONArray values = new JSONArray();
        for (Entry entry : entries == null ? List.<Entry>of() : entries) {
            try {
                if (entry.valid()) values.put(new JSONObject()
                        .put("local_id", entry.localId).put("gateway_id", entry.gatewayId)
                        .put("video_id", entry.videoId));
            } catch (Exception ignored) {
            }
        }
        return values.toString();
    }

    static List<Entry> deserialize(String encoded) {
        List<Entry> result = new ArrayList<>();
        try {
            JSONArray values = new JSONArray(encoded == null || encoded.isBlank() ? "[]" : encoded);
            for (int i = 0; i < Math.min(values.length(), MAX_RECORDS); i++) {
                JSONObject value = values.optJSONObject(i);
                Entry entry = value == null ? null : new Entry(value.optString("local_id", ""),
                        value.optString("gateway_id", ""), value.optString("video_id", ""));
                if (entry != null && entry.valid()) result.add(entry);
            }
        } catch (Exception ignored) {
        }
        return result;
    }

    static final class Entry {
        final String localId;
        final String gatewayId;
        final String videoId;

        Entry(String localId, String gatewayId, String videoId) {
            this.localId = safe(localId);
            this.gatewayId = safe(gatewayId);
            this.videoId = safe(videoId);
        }

        boolean valid() {
            return (localId.matches("[A-Za-z0-9_-]{1,200}")
                    || gatewayId.matches("[A-Za-z0-9_-]{1,120}"))
                    && (videoId.isEmpty() || MoaMediaSpotStore.isValidYouTubeVideoId(videoId));
        }

        String key() {
            return localId + "\n" + gatewayId;
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}
