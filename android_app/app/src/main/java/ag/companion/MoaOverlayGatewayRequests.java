package ag.companion;

import android.content.ContentResolver;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;

/** Builds bounded Android-overlay gateway envelopes without owning turn routing. */
final class MoaOverlayGatewayRequests {
    private MoaOverlayGatewayRequests() {}

    static JSONObject turnBody(ContentResolver resolver, String conversationId,
            String branchId, List<ChatMessage> messages, int messageLimit,
            MoaActionBroker actionBroker) throws JSONException {
        JSONObject body = new JSONObject();
        body.put("conversation_id", conversationId);
        body.put("branch_id", branchId);
        body.put("source", "android-overlay");
        body.put("device_id", deviceId(resolver));
        actionBroker.putScreenContext(body);
        body.put("messages", history(messages, messageLimit));
        return body;
    }

    static JSONArray history(List<ChatMessage> messages, int messageLimit) throws JSONException {
        JSONArray history = new JSONArray();
        int start = Math.max(0, messages.size() - Math.max(0, messageLimit));
        for (int i = start; i < messages.size(); i++) {
            ChatMessage message = messages.get(i);
            JSONObject item = new JSONObject();
            item.put("role", message.assistant ? "assistant" : "user");
            item.put("content", message.text);
            history.put(item);
        }
        return history;
    }

    static String deviceId(ContentResolver resolver) {
        String raw = Settings.Secure.getString(resolver, Settings.Secure.ANDROID_ID);
        String safe = raw == null ? "" : raw.replaceAll("[^a-zA-Z0-9_-]", "");
        return "android_" + (safe.isEmpty() ? "unknown" : safe);
    }
}
