package ai.moa.assistant;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

/** Synchronous durable pending/replay/receipt store. No effect starts unless commit succeeds. */
final class MoaSurfaceProgramStore {
    private static final String PREFS = "moa_surface_programs_v1";
    private static final String KEY_ENTRIES = "entries";
    private static final int MAX_ENTRIES = 80;
    interface Persistence { String read(); boolean write(String value); }
    private final Persistence persistence;

    MoaSurfaceProgramStore(Context context) {
        this(new Persistence() {
            public String read() { return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ENTRIES, "[]"); }
            public boolean write(String value) { return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_ENTRIES, value).commit(); }
        });
    }
    MoaSurfaceProgramStore(Persistence persistence) { this.persistence = persistence; }

    synchronized JSONObject existing(String executionId, String idempotencyKey) {
        JSONArray entries = entries();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry != null && !entry.optBoolean("collision", false)
                    && (executionId.equals(entry.optString("execution_id")) || idempotencyKey.equals(entry.optString("idempotency_key")))) return MoaProgramJson.copy(entry);
        }
        return null;
    }

    synchronized boolean recordPending(MoaSurfaceProgramContract.Proposal proposal) {
        return recordPending(proposal, "android:overlay");
    }

    synchronized boolean recordPending(MoaSurfaceProgramContract.Proposal proposal, String clientId) {
        return recordPending(proposal, clientId, "");
    }

    synchronized boolean recordPending(MoaSurfaceProgramContract.Proposal proposal, String clientId, String requestId) {
        if (existing(proposal.executionId, proposal.idempotencyKey) != null) return false;
        JSONArray entries = entries();
        try {
            long now = System.currentTimeMillis();
            JSONArray events = new JSONArray().put(MoaSurfaceProgramEvents.accepted(proposal, clientId, 1, now))
                    .put(MoaSurfaceProgramEvents.started(proposal, clientId, 2, now));
            entries.put(new JSONObject().put("execution_id", proposal.executionId).put("sync_key", proposal.executionId).put("idempotency_key", proposal.idempotencyKey)
                    .put("proposal_sha256", proposal.proposalSha256).put("status", "pending").put("program_sha256", proposal.programSha256).put("tool_receipts", new JSONArray())
                    .put("pending_attempts", new JSONArray()).put("pending_effects", new JSONArray()).put("events", events)
                    .put("request_id", requestId).put("sync", initialSync()));
        } catch (Exception error) { return false; }
        trim(entries);
        return commit(entries);
    }

    synchronized JSONObject recordRejected(MoaSurfaceProgramContract.Proposal proposal, String clientId, String errorCode) {
        return recordRejected(proposal, clientId, "", errorCode);
    }

    synchronized JSONObject recordRejected(MoaSurfaceProgramContract.Proposal proposal, String clientId, String requestId, String errorCode) {
        if (existing(proposal.executionId, proposal.idempotencyKey) != null) return null;
        JSONArray entries = entries();
        try {
            long now = System.currentTimeMillis();
            JSONObject terminal = MoaSurfaceProgramReceipts.terminal(proposal, clientId, "rejected", new JSONArray(), 0, now, null, errorCode);
            JSONArray events = new JSONArray().put(MoaSurfaceProgramEvents.terminal(proposal, clientId, 1, terminal, now));
            entries.put(new JSONObject().put("execution_id", proposal.executionId).put("sync_key", proposal.executionId).put("idempotency_key", proposal.idempotencyKey)
                    .put("proposal_sha256", proposal.proposalSha256).put("status", "rejected").put("program_sha256", proposal.programSha256)
                    .put("tool_receipts", new JSONArray()).put("pending_attempts", new JSONArray()).put("pending_effects", new JSONArray())
                    .put("events", events).put("terminal", terminal).put("request_id", requestId).put("sync", initialSync()));
            trim(entries);
            return commit(entries) ? terminal : null;
        } catch (Exception error) { return null; }
    }

    synchronized String recordCollisionRejected(MoaSurfaceProgramContract.Proposal proposal, String clientId,
                                                String requestId) {
        JSONArray entries = entries();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject prior = entries.optJSONObject(i);
            if (prior != null && prior.optBoolean("collision", false)
                    && requestId.equals(prior.optString("request_id"))
                    && proposal.proposalSha256.equals(prior.optString("proposal_sha256"))) {
                return prior.optString("sync_key", null);
            }
        }
        try {
            long now = System.currentTimeMillis();
            JSONObject terminal = MoaSurfaceProgramReceipts.terminal(proposal, clientId, "rejected",
                    new JSONArray(), 0, now, null, "proposal_rejected");
            JSONArray events = new JSONArray().put(MoaSurfaceProgramEvents.terminal(proposal, clientId, 1, terminal, now));
            String syncKey = proposal.executionId + "#" + proposal.proposalSha256 + "#" + requestId;
            entries.put(new JSONObject().put("execution_id", proposal.executionId).put("sync_key", syncKey)
                    .put("idempotency_key", proposal.idempotencyKey).put("proposal_sha256", proposal.proposalSha256)
                    .put("collision", true).put("status", "rejected").put("program_sha256", proposal.programSha256)
                    .put("tool_receipts", new JSONArray()).put("pending_attempts", new JSONArray())
                    .put("pending_effects", new JSONArray()).put("events", events).put("terminal", terminal)
                    .put("request_id", requestId).put("sync", initialSync()));
            trim(entries);
            return commit(entries) ? syncKey : null;
        } catch (Exception error) { return null; }
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
                return commit(entries);
            }
        }
        return false;
    }

    synchronized boolean beginTool(MoaSurfaceProgramContract.Proposal proposal, String clientId, String callId,
                                   String capabilityId, String inputSha256, boolean effectful, long startedAtMs) {
        JSONArray entries = entries();
        JSONObject entry = findPending(entries, proposal.executionId);
        if (entry == null) return false;
        try {
            JSONArray events = array(entry, "events");
            events.put(MoaSurfaceProgramEvents.toolStarted(proposal, clientId, events.length() + 1, capabilityId, callId, startedAtMs));
            JSONObject marker = new JSONObject().put("tool_call_id", callId).put("capability_id", capabilityId)
                    .put("input_sha256", inputSha256).put("attempt", 1).put("effectful", effectful)
                    .put("started_at", MoaSurfaceProgramEvents.timestamp(startedAtMs));
            array(entry, "pending_attempts").put(marker);
            if (effectful) array(entry, "pending_effects").put(new JSONObject().put("tool_call_id", callId)
                    .put("capability_id", capabilityId).put("input_sha256", inputSha256).put("started_at", MoaSurfaceProgramEvents.timestamp(startedAtMs)));
            return commit(entries);
        } catch (Exception error) { return false; }
    }

    synchronized boolean finishTool(MoaSurfaceProgramContract.Proposal proposal, String clientId, String callId,
                                    String capabilityId, JSONObject receipt, long finishedAtMs) {
        JSONArray entries = entries();
        JSONObject entry = findPending(entries, proposal.executionId);
        if (entry == null) return false;
        try {
            array(entry, "tool_receipts").put(receipt);
            removeCall(array(entry, "pending_attempts"), callId);
            JSONArray pending = array(entry, "pending_effects");
            removeCall(pending, callId);
            JSONArray events = array(entry, "events");
            events.put(MoaSurfaceProgramEvents.toolFinished(proposal, clientId, events.length() + 1, capabilityId, callId, receipt, finishedAtMs));
            return commit(entries);
        } catch (Exception error) { return false; }
    }

    synchronized boolean recordTerminal(MoaSurfaceProgramContract.Proposal proposal, JSONObject terminal) {
        return recordTerminal(proposal, "android:overlay", terminal);
    }

    synchronized boolean recordTerminal(MoaSurfaceProgramContract.Proposal proposal, String clientId, JSONObject terminal) {
        JSONArray entries = entries();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry != null && proposal.executionId.equals(entry.optString("execution_id"))) {
                if (hasPendingAttempt(entry)) return false;
                try { JSONArray events = array(entry, "events"); entry.put("status", terminal.optString("status")).put("terminal", terminal);
                    events.put(MoaSurfaceProgramEvents.terminal(proposal, clientId, events.length() + 1, terminal, System.currentTimeMillis())); }
                catch (Exception error) { return false; }
                return commit(entries);
            }
        }
        return false;
    }

    synchronized boolean hasPendingEffect(JSONObject entry) { JSONArray pending = entry == null ? null : entry.optJSONArray("pending_effects"); return pending != null && pending.length() > 0; }

    synchronized boolean hasPendingAttempt(JSONObject entry) { return pendingAttempts(entry).length() > 0; }

    synchronized JSONObject recoverIndeterminate(MoaSurfaceProgramContract.Proposal proposal, String clientId) {
        JSONObject entry = existing(proposal.executionId, proposal.idempotencyKey);
        JSONArray pending = pendingAttempts(entry);
        if (pending.length() == 0) return null;
        JSONArray receipts = entry.optJSONArray("tool_receipts"); if (receipts == null) receipts = new JSONArray();
        String previous = receipts.length() == 0 ? "" : receipts.optJSONObject(receipts.length() - 1).optString("receipt_sha256", "");
        String preState = proposal.observationDigest;
        if (receipts.length() > 0) { String post = receipts.optJSONObject(receipts.length() - 1).optString("post_state_sha256", ""); if (!post.isEmpty()) preState = post; }
        try {
            JSONArray events = entry.optJSONArray("events"); if (events == null) events = new JSONArray();
            for (int i = 0; i < pending.length(); i++) {
                JSONObject marker = pending.getJSONObject(i); String callId = marker.getString("tool_call_id"), capability = marker.getString("capability_id");
                long started = java.time.Instant.parse(marker.getString("started_at")).toEpochMilli();
                JSONObject receipt = MoaSurfaceProgramReceipts.toolFromDigest(proposal, clientId, callId, marker.optInt("attempt", 1), capability,
                        marker.getString("input_sha256"), "indeterminate", previous, preState, null, started, System.currentTimeMillis());
                receipts.put(receipt); events.put(MoaSurfaceProgramEvents.toolFinished(proposal, clientId, events.length() + 1, capability, callId, receipt, System.currentTimeMillis()));
                previous = receipt.getString("receipt_sha256");
            }
            JSONObject terminal = MoaSurfaceProgramReceipts.terminal(proposal, clientId, "indeterminate", receipts,
                    durableStartedAt(entry, proposal.issuedAtMs), System.currentTimeMillis(), null, "indeterminate");
            events.put(MoaSurfaceProgramEvents.terminal(proposal, clientId, events.length() + 1, terminal, System.currentTimeMillis()));
            entry.put("tool_receipts", receipts).put("events", events).put("pending_attempts", new JSONArray())
                    .put("pending_effects", new JSONArray()).put("status", "indeterminate").put("terminal", terminal);
            return commit(entriesWithReplacement(entry)) ? terminal : null;
        } catch (Exception error) { return null; }
    }

    synchronized boolean bindRequest(String executionId, String idempotencyKey, String requestId) {
        if (requestId == null || requestId.trim().isEmpty()) return false;
        JSONArray entries = entries();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry == null || entry.optBoolean("collision", false)
                    || (!executionId.equals(entry.optString("execution_id")) && !idempotencyKey.equals(entry.optString("idempotency_key")))) continue;
            String existing = entry.optString("request_id", "");
            if (!existing.isEmpty() && !existing.equals(requestId)) return false;
            try { entry.put("request_id", requestId); if (entry.optJSONObject("sync") == null) entry.put("sync", initialSync()); }
            catch (Exception error) { return false; }
            return commit(entries);
        }
        return false;
    }

    synchronized JSONArray pendingSyncEntries() {
        JSONArray pending = new JSONArray(), entries = entries();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry != null && !entry.optString("request_id", "").isEmpty() && nextSyncDelivery(entry) != null) pending.put(MoaProgramJson.copy(entry));
        }
        return pending;
    }

    synchronized JSONObject nextSyncDelivery(String executionId) {
        JSONArray entries = entries();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry != null && executionId.equals(entry.optString("sync_key", entry.optString("execution_id")))) return nextSyncDelivery(entry);
        }
        return null;
    }

    synchronized boolean acknowledgeSyncDelivery(String executionId, String deliveryId) {
        JSONArray entries = entries();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry == null || !executionId.equals(entry.optString("sync_key", entry.optString("execution_id")))) continue;
            JSONObject delivery = nextSyncDelivery(entry);
            if (delivery == null || !deliveryId.equals(delivery.optString("delivery_id"))) return false;
            JSONObject sync = sync(entry);
            try {
                if (deliveryId.startsWith("prerequisite:")) sync.put("prerequisite_acked", true);
                else { sync.put("event_index", sync.optInt("event_index", 0) + 1); sync.put("prerequisite_acked", false); }
            } catch (Exception error) { return false; }
            return commit(entries);
        }
        return false;
    }

    private JSONArray entriesWithReplacement(JSONObject replacement) { JSONArray entries = entries(); for (int i = 0; i < entries.length(); i++) if (replacement.optString("execution_id").equals(entries.optJSONObject(i) == null ? "" : entries.optJSONObject(i).optString("execution_id"))) { entries.remove(i); entries.put(replacement); break; } return entries; }

    private static JSONObject nextSyncDelivery(JSONObject entry) {
        String requestId = entry.optString("request_id", ""); if (requestId.isEmpty()) return null;
        JSONArray events = entry.optJSONArray("events"); if (events == null) return null;
        JSONObject sync = sync(entry); int index = sync.optInt("event_index", 0); if (index < 0 || index >= events.length()) return null;
        JSONObject event = events.optJSONObject(index); if (event == null) return null;
        String kind = event.optString("kind"), prerequisite = null; JSONObject payload = null;
        if (!sync.optBoolean("prerequisite_acked", false) && "tool_finished".equals(kind)) {
            String receiptId = event.optJSONObject("payload") == null ? "" : event.optJSONObject("payload").optString("receipt_id");
            JSONArray receipts = entry.optJSONArray("tool_receipts");
            for (int i = 0; receipts != null && i < receipts.length(); i++) { JSONObject receipt = receipts.optJSONObject(i); if (receipt != null && receiptId.equals(receipt.optString("receipt_id"))) { payload = receipt; break; } }
            prerequisite = "tool_receipt";
        } else if (!sync.optBoolean("prerequisite_acked", false) && "terminal".equals(kind)) { payload = entry.optJSONObject("terminal"); prerequisite = "terminal_receipt"; }
        if (prerequisite != null && payload == null) return null;
        try { return new JSONObject().put("delivery_id", (prerequisite == null ? "event:" : "prerequisite:") + index)
                .put("kind", prerequisite == null ? "event" : prerequisite).put("request_id", requestId)
                .put("execution_id", entry.optString("execution_id")).put("sync_key", entry.optString("sync_key", entry.optString("execution_id")))
                .put("payload", prerequisite == null ? event : payload); }
        catch (Exception impossible) { return null; }
    }

    private static JSONObject initialSync() { try { return new JSONObject().put("event_index", 0).put("prerequisite_acked", false); } catch (Exception impossible) { return new JSONObject(); } }
    private static JSONObject sync(JSONObject entry) { JSONObject sync = entry.optJSONObject("sync"); if (sync == null) { sync = initialSync(); try { entry.put("sync", sync); } catch (Exception ignored) {} } return sync; }
    private static JSONArray pendingAttempts(JSONObject entry) { if (entry == null) return new JSONArray(); JSONArray attempts = entry.optJSONArray("pending_attempts"); if (attempts != null) return attempts; JSONArray legacy = entry.optJSONArray("pending_effects"); return legacy == null ? new JSONArray() : legacy; }
    private static void removeCall(JSONArray markers, String callId) throws Exception { for (int i = markers.length() - 1; i >= 0; i--) if (callId.equals(markers.getJSONObject(i).optString("tool_call_id"))) markers.remove(i); }
    private static long durableStartedAt(JSONObject entry, long fallback) { JSONArray events = entry.optJSONArray("events"); for (int i = 0; events != null && i < events.length(); i++) { JSONObject event = events.optJSONObject(i); if (event != null && "started".equals(event.optString("kind"))) try { return java.time.Instant.parse(event.getString("occurred_at")).toEpochMilli(); } catch (Exception ignored) { return fallback; } } return fallback; }

    private static JSONObject findPending(JSONArray entries, String executionId) { for (int i = 0; i < entries.length(); i++) { JSONObject entry = entries.optJSONObject(i); if (entry != null && executionId.equals(entry.optString("execution_id")) && "pending".equals(entry.optString("status"))) return entry; } return null; }
    private static JSONArray array(JSONObject entry, String key) throws Exception { JSONArray result = entry.optJSONArray(key); if (result == null) { result = new JSONArray(); entry.put(key, result); } return result; }
    private boolean commit(JSONArray entries) { return persistence.write(entries.toString()); }

    private JSONArray entries() { try { return new JSONArray(persistence.read()); } catch (Exception ignored) { return new JSONArray(); } }
    private static void trim(JSONArray entries) {
        while (entries.length() > MAX_ENTRIES) {
            int removable = -1;
            for (int i = 0; i < entries.length(); i++) { JSONObject entry = entries.optJSONObject(i); if (entry == null || entry.optString("request_id", "").isEmpty() || syncComplete(entry)) { removable = i; break; } }
            if (removable < 0) return;
            entries.remove(removable);
        }
    }

    private static boolean syncComplete(JSONObject entry) { JSONArray events = entry.optJSONArray("events"); return events != null && sync(entry).optInt("event_index", 0) >= events.length(); }
}
