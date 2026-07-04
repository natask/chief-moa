package ai.moa.assistant;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

final class MoaGatewayClient {
    private final String baseUrl;
    private final String token;

    MoaGatewayClient(String baseUrl, String token) {
        this.baseUrl = safe(baseUrl);
        this.token = safe(token);
    }

    GatewayTextResponse chat(JSONObject body) throws Exception {
        String responseText = postJson(apiEndpoint("/v1/chat"), body.toString(), 90000);
        JSONObject response = new JSONObject(responseText);
        String text = response.optString("text", response.optString("reply", "")).trim();
        if (text.isEmpty()) {
            throw new IllegalStateException("empty gateway reply");
        }
        return new GatewayTextResponse(text, response.optString("conversation_id", "").trim());
    }

    JSONObject voiceTurn(JSONObject body) throws Exception {
        String responseText = postJson(apiEndpoint("/v1/voice/turns"), body.toString(), 90000);
        return new JSONObject(responseText);
    }

    JSONObject agentRuns(int limit) throws Exception {
        int safeLimit = Math.max(1, Math.min(limit, 100));
        String responseText = getText(apiEndpoint("/v1/agent/runs?limit=" + safeLimit), 15000);
        return new JSONObject(responseText);
    }

    JSONObject agentRunDetail(String runId) throws Exception {
        String id = safe(runId).replaceAll("[^a-zA-Z0-9_-]", "");
        if (id.isEmpty()) {
            throw new IllegalArgumentException("run id is required");
        }
        String responseText = getText(apiEndpoint("/v1/agent/runs/" + id), 15000);
        return new JSONObject(responseText);
    }

    JSONObject latestAndroidUpdate() throws Exception {
        String responseText = getText(apiEndpoint("/v1/android/updates/latest"), 10000);
        return new JSONObject(responseText);
    }

    JSONObject latestContext() throws Exception {
        String responseText = getText(apiEndpoint("/v1/context/latest"), 15000);
        return new JSONObject(responseText);
    }

    JSONObject agentProfile(String scope, String deviceId) throws Exception {
        String query = "";
        String safeScope = safe(scope);
        String safeDeviceId = safe(deviceId);
        if (!safeScope.isEmpty()) {
            query = "?scope=" + urlEncode(safeScope);
            if (!safeDeviceId.isEmpty()) {
                query += "&device_id=" + urlEncode(safeDeviceId);
            }
        }
        String responseText = getText(apiEndpoint("/v1/agent/profile" + query), 15000);
        return new JSONObject(responseText);
    }

    JSONObject deviceHeartbeat(JSONObject body) throws Exception {
        String responseText = postJson(apiEndpoint("/v1/device-clients/heartbeat"), body.toString(), 15000);
        return new JSONObject(responseText);
    }

    JSONObject claimToolRequest(JSONObject body) throws Exception {
        String responseText = postJson(apiEndpoint("/v1/tool/requests/claim"), body.toString(), 15000);
        if (responseText.trim().isEmpty()) {
            return new JSONObject();
        }
        return new JSONObject(responseText);
    }

    JSONObject toolRequestReceipt(String requestId, JSONObject body) throws Exception {
        String id = safe(requestId).replaceAll("[^a-zA-Z0-9_-]", "");
        if (id.isEmpty()) {
            throw new IllegalArgumentException("tool request id is required");
        }
        String responseText = postJson(apiEndpoint("/v1/tool/requests/" + id + "/receipts"), body.toString(), 15000);
        return new JSONObject(responseText);
    }

    void downloadLatestAndroidUpdate(File destination) throws Exception {
        downloadFile(apiEndpoint("/v1/android/updates/latest.apk"), destination, 120000);
    }

    JSONObject agentRun(JSONObject body) throws Exception {
        String responseText = postJson(apiEndpoint("/v1/agent/runs"), body.toString(), 30000);
        return new JSONObject(responseText);
    }

    JSONObject agentRunFollowUp(String runId, JSONObject body) throws Exception {
        String id = safe(runId).replaceAll("[^a-zA-Z0-9_-]", "");
        if (id.isEmpty()) {
            throw new IllegalArgumentException("run id is required");
        }
        String responseText = postJson(apiEndpoint("/v1/agent/runs/" + id + "/followups"), body.toString(), 30000);
        return new JSONObject(responseText);
    }

    static String agentRunReply(JSONObject response) {
        JSONObject run = response.optJSONObject("run");
        String reply = response.optString("text", "").trim();
        if (reply.isEmpty() && run != null) {
            reply = "Home-machine agent run " + run.optString("id", "") + " is " + run.optString("status", "unknown") + ".";
        }
        if (reply.isEmpty()) {
            throw new IllegalStateException("empty agent run reply");
        }
        return reply;
    }

    private String postJson(String endpoint, String requestBody, int readTimeoutMs) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(3500);
        connection.setReadTimeout(readTimeoutMs);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        if (!token.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }

        byte[] payload = requestBody.getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(payload.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(payload);
        }

        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String responseText = readStream(stream);
        connection.disconnect();

        if (status < 200 || status >= 300) {
            throw new IllegalStateException("HTTP " + status + " " + responseText);
        }
        return responseText;
    }

    private String getText(String endpoint, int readTimeoutMs) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(3500);
        connection.setReadTimeout(readTimeoutMs);
        if (!token.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }

        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String responseText = readStream(stream);
        connection.disconnect();

        if (status < 200 || status >= 300) {
            throw new IllegalStateException("HTTP " + status + " " + responseText);
        }
        return responseText;
    }

    private void downloadFile(String endpoint, File destination, int readTimeoutMs) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(3500);
        connection.setReadTimeout(readTimeoutMs);
        if (!token.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }

        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            String responseText = readStream(connection.getErrorStream());
            connection.disconnect();
            throw new IllegalStateException("HTTP " + status + " " + responseText);
        }

        File parent = destination.getParentFile();
        if (parent != null) {
            parent.mkdirs();
        }
        try (InputStream input = connection.getInputStream();
             OutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[32 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                output.write(buffer, 0, read);
            }
        } finally {
            connection.disconnect();
        }
    }

    private String apiEndpoint(String apiPath) {
        String base = baseUrl;
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        if (base.endsWith("/v1/chat")) {
            base = base.substring(0, base.length() - "/v1/chat".length());
        }
        return base + apiPath;
    }

    private static String readStream(InputStream stream) throws Exception {
        if (stream == null) {
            return "";
        }

        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
        }
        return builder.toString();
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    private static String urlEncode(String value) throws Exception {
        return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8.name());
    }

    static final class GatewayTextResponse {
        final String text;
        final String conversationId;

        GatewayTextResponse(String text, String conversationId) {
            this.text = text;
            this.conversationId = conversationId == null ? "" : conversationId.trim();
        }
    }
}
