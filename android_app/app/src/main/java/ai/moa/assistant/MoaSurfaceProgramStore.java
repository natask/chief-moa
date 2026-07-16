package ai.moa.assistant;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/** Synchronous durable pending/replay/receipt store. No effect starts unless commit succeeds. */
final class MoaSurfaceProgramStore {
    private static final String PREFS = "moa_surface_programs_v1";
    private static final String KEY_ENTRIES = "entries";
    private static final int MAX_ENTRIES = 80;
    private final SharedPreferences preferences;

    MoaSurfaceProgramStore(Context context) { preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    synchronized JSONObject existing(String executionId, String idempotencyKey) {
        JSONArray entries = entries();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry != null && (executionId.equals(entry.optString("execution_id")) || idempotencyKey.equals(entry.optString("idempotency_key")))) return MoaProgramJson.copy(entry);
        }
        return null;
    }

    synchronized boolean recordPending(MoaSurfaceProgramContract.Proposal proposal) {
        if (existing(proposal.executionId, proposal.idempotencyKey) != null) return false;
        JSONArray entries = entries();
        try {
            entries.put(new JSONObject().put("execution_id", proposal.executionId).put("idempotency_key", proposal.idempotencyKey)
                    .put("status", "pending").put("program_sha256", proposal.programSha256).put("tool_receipts", new JSONArray()));
        } catch (Exception error) { return false; }
        trim(entries);
        return preferences.edit().putString(KEY_ENTRIES, entries.toString()).commit();
    }

    synchronized boolean recordToolReceipt(MoaSurfaceProgramContract.Proposal proposal, JSONObject receipt) {
        JSONArray entries = entries();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry != null && proposal.executionId.equals(entry.optString("execution_id")) && "pending".equals(entry.optString("status"))) {
                JSONArray receipts = entry.optJSONArray("tool_receipts");
                if (receipts == null) receipts = new JSONArray();
                receipts.put(receipt);
                try { entry.put("tool_receipts", receipts); }
                catch (Exception error) { return false; }
                return preferences.edit().putString(KEY_ENTRIES, entries.toString()).commit();
            }
        }
        return false;
    }

    synchronized boolean recordTerminal(MoaSurfaceProgramContract.Proposal proposal, JSONObject terminal) {
        JSONArray entries = entries();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry != null && proposal.executionId.equals(entry.optString("execution_id"))) {
                try { entry.put("status", terminal.optString("status")).put("terminal", terminal); }
                catch (Exception error) { return false; }
                return preferences.edit().putString(KEY_ENTRIES, entries.toString()).commit();
            }
        }
        return false;
    }

    private JSONArray entries() { try { return new JSONArray(preferences.getString(KEY_ENTRIES, "[]")); } catch (Exception ignored) { return new JSONArray(); } }
    private static void trim(JSONArray entries) { while (entries.length() > MAX_ENTRIES) entries.remove(0); }
}
