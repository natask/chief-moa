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

    static JSONObject recordDraftInsertion(Context context, MoaDraftInsertionPolicy.Receipt draft) {
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
        return record(
                context,
                "screen.insert_text",
                "communication_draft",
                "explicit_local_approval",
                draft == null ? "" : draft.targetPackage,
                success,
                draft == null ? "Insertion refused" : MoaDraftInsertionPolicy.reasonMessage(draft.reason),
                details
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

    static JSONArray receipts(Context context) {
        String json = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_RECEIPTS, "[]");
        try {
            return new JSONArray(json);
        } catch (JSONException ignored) {
            return new JSONArray();
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
