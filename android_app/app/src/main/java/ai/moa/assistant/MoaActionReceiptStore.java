package ai.moa.assistant;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

final class MoaActionReceiptStore {
    private static final String PREFS = "moa_action_receipts";
    private static final String KEY_RECEIPTS = "receipts_json";
    private static final String KEY_LAST_HASH = "last_hash";
    private static final int MAX_RECEIPTS = 80;

    private MoaActionReceiptStore() {
    }

    static JSONObject record(Context context, String tool, String risk, String approval, String target, boolean success, String result) {
        return record(context, tool, risk, approval, target, success, result, null);
    }

    static WriteResult recordDraftInsertion(Context context, MoaDraftInsertionPolicy.Receipt draft) {
        return recordDraftInsertion(
                draft,
                new SharedPreferencesBackend(context),
                System.currentTimeMillis()
        );
    }

    static WriteResult recordDraftInsertion(
            MoaDraftInsertionPolicy.Receipt draft,
            ReceiptBackend backend,
            long timestampMs
    ) {
        JSONObject details = new JSONObject();
        try {
            details.put("proposal_id", safe(draft == null ? "" : draft.proposalId));
            details.put("target_package", safe(draft == null ? "" : draft.targetPackage));
            details.put("target_fingerprint", safe(draft == null ? "" : draft.targetFingerprint));
            details.put("proposed_text_sha256", safe(draft == null ? "" : draft.proposedTextSha256));
            details.put("effect", draft == null ? "" : draft.effectPath.name().toLowerCase(Locale.ROOT));
            details.put("status", draft == null ? "refused" : draft.status.name().toLowerCase(Locale.ROOT));
            details.put("reason", draft == null ? "invalid_proposal" : draft.reason.name().toLowerCase(Locale.ROOT));
        } catch (JSONException ignored) {
        }
        boolean success = draft != null && draft.succeeded();
        return recordWithBackend(
                backend,
                "screen.insert_text",
                "communication_draft",
                "explicit_local_approval",
                draft == null ? "" : draft.targetPackage,
                success,
                draft == null ? "Insertion refused" : MoaDraftInsertionPolicy.reasonMessage(draft.reason),
                details,
                timestampMs
        );
    }

    private static JSONObject record(
            Context context,
            String tool,
            String risk,
            String approval,
            String target,
            boolean success,
            String result,
            JSONObject details
    ) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String previousHash = prefs.getString(KEY_LAST_HASH, "");
        JSONObject receipt = new JSONObject();
        try {
            receipt.put("tool", safe(tool));
            receipt.put("risk", safe(risk));
            receipt.put("approval", safe(approval));
            receipt.put("target", safe(target));
            receipt.put("success", success);
            receipt.put("result", safe(result));
            if (details != null) {
                receipt.put("details", new JSONObject(details.toString()));
            }
            receipt.put("timestamp_ms", System.currentTimeMillis());
            receipt.put("previous_hash", previousHash);
            receipt.put("hash", hash(receipt.toString()));
        } catch (JSONException ignored) {
        }

        JSONArray receipts = receipts(context);
        receipts.put(receipt);
        while (receipts.length() > MAX_RECEIPTS) {
            receipts.remove(0);
        }
        prefs.edit()
                .putString(KEY_RECEIPTS, receipts.toString())
                .putString(KEY_LAST_HASH, receipt.optString("hash", previousHash))
                .apply();
        return receipt;
    }

    private static WriteResult recordWithBackend(
            ReceiptBackend backend,
            String tool,
            String risk,
            String approval,
            String target,
            boolean success,
            String result,
            JSONObject details,
            long timestampMs
    ) {
        String previousHash = backend == null ? "" : safe(backend.lastHash());
        JSONObject receipt = buildReceipt(
                tool, risk, approval, target, success, result, details, timestampMs, previousHash);
        JSONArray chain = parseReceipts(backend == null ? "[]" : backend.receiptsJson());
        chain.put(receipt);
        while (chain.length() > MAX_RECEIPTS) {
            chain.remove(0);
        }
        boolean persisted = false;
        if (backend != null) {
            try {
                persisted = backend.write(chain.toString(), receipt.optString("hash", previousHash));
            } catch (RuntimeException ignored) {
                persisted = false;
            }
        }
        return new WriteResult(receipt, persisted);
    }

    private static JSONObject buildReceipt(
            String tool,
            String risk,
            String approval,
            String target,
            boolean success,
            String result,
            JSONObject details,
            long timestampMs,
            String previousHash
    ) {
        JSONObject receipt = new JSONObject();
        try {
            receipt.put("tool", safe(tool));
            receipt.put("risk", safe(risk));
            receipt.put("approval", safe(approval));
            receipt.put("target", safe(target));
            receipt.put("success", success);
            receipt.put("result", safe(result));
            if (details != null) {
                receipt.put("details", new JSONObject(details.toString()));
            }
            receipt.put("timestamp_ms", timestampMs);
            receipt.put("previous_hash", safe(previousHash));
            receipt.put("hash", hash(receipt.toString()));
        } catch (JSONException ignored) {
        }
        return receipt;
    }

    private static JSONArray parseReceipts(String json) {
        try {
            return new JSONArray(json == null ? "[]" : json);
        } catch (JSONException ignored) {
            return new JSONArray();
        }
    }

    static JSONArray receipts(Context context) {
        String json = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_RECEIPTS, "[]");
        try {
            return new JSONArray(json);
        } catch (JSONException ignored) {
            return new JSONArray();
        }
    }

    interface ReceiptBackend {
        String receiptsJson();

        String lastHash();

        boolean write(String receiptsJson, String lastHash);
    }

    static final class WriteResult {
        final JSONObject receipt;
        final boolean persisted;

        WriteResult(JSONObject receipt, boolean persisted) {
            this.receipt = receipt;
            this.persisted = persisted;
        }
    }

    private static final class SharedPreferencesBackend implements ReceiptBackend {
        private final SharedPreferences preferences;

        SharedPreferencesBackend(Context context) {
            SharedPreferences loaded;
            try {
                loaded = context == null
                        ? null
                        : context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            } catch (RuntimeException ignored) {
                loaded = null;
            }
            preferences = loaded;
        }

        @Override
        public String receiptsJson() {
            try {
                return preferences == null ? "[]" : preferences.getString(KEY_RECEIPTS, "[]");
            } catch (RuntimeException ignored) {
                return "[]";
            }
        }

        @Override
        public String lastHash() {
            try {
                return preferences == null ? "" : preferences.getString(KEY_LAST_HASH, "");
            } catch (RuntimeException ignored) {
                return "";
            }
        }

        @Override
        public boolean write(String receiptsJson, String lastHash) {
            if (preferences == null) {
                return false;
            }
            try {
                return preferences.edit()
                        .putString(KEY_RECEIPTS, receiptsJson)
                        .putString(KEY_LAST_HASH, lastHash)
                        .commit();
            } catch (RuntimeException ignored) {
                return false;
            }
        }
    }

    private static String hash(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder builder = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) {
                builder.append(String.format(Locale.US, "%02x", b));
            }
            return builder.toString();
        } catch (Exception error) {
            return "";
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}
