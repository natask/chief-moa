package ai.moa.assistant;

import org.json.JSONObject;
import org.json.JSONArray;

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
import java.util.Map;

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
        return new GatewayTextResponse(
                text,
                response.optString("conversation_id", "").trim(),
                turnNotPersisted(response));
    }

    JSONObject voiceTurn(JSONObject body) throws Exception {
        String responseText = postJson(apiEndpoint("/v1/voice/turns"), body.toString(), 90000);
        return new JSONObject(responseText);
    }

    // Set the active thread for the shared session, or mint a new/fork/incognito
    // branch. Streaming voice must call this before opening the WS session so the
    // socket branch is fixed to the resolved thread; the reply carries the
    // resolved branch under `thread.branch_id`.
    JSONObject switchThread(JSONObject body) throws Exception {
        String responseText = postJson(apiEndpoint("/v1/threads/switch"), body.toString(), 15000);
        if (responseText.trim().isEmpty()) {
            return new JSONObject();
        }
        return new JSONObject(responseText);
    }

    // A turn whose response context block says persisted:false was answered but
    // never stored (incognito). Clients surface a "(not saved)" cue for it.
    static boolean turnNotPersisted(JSONObject response) {
        JSONObject context = response == null ? null : response.optJSONObject("context");
        return context != null && context.has("persisted") && !context.optBoolean("persisted", true);
    }

    // Resolve the branch a /v1/threads/switch response landed on. The gateway
    // returns the resolved thread under `thread.branch_id`; fall back through the
    // active pointer and a top-level field for older shapes.
    static String branchIdFromSwitch(JSONObject response) {
        if (response == null) {
            return "";
        }
        String direct = safe(response.optString("branch_id", ""));
        if (!direct.isEmpty()) {
            return direct;
        }
        JSONObject thread = response.optJSONObject("thread");
        if (thread != null) {
            String value = firstNonEmpty(thread.optString("branch_id", ""), thread.optString("id", ""));
            if (!value.isEmpty()) {
                return value;
            }
        }
        JSONObject active = response.optJSONObject("active");
        if (active != null) {
            String value = firstNonEmpty(active.optString("branch_id", ""), active.optString("id", ""));
            if (!value.isEmpty()) {
                return value;
            }
        }
        return "";
    }

    // Record mode: upload a finished raw-audio note. This is a plain HTTP POST
    // of the captured bytes; it never opens a voice session, so no STT, LLM,
    // or TTS can run on this path by construction.
    JSONObject uploadAudioNote(byte[] audio, String contentType, Map<String, String> metadataHeaders) throws Exception {
        if (audio == null || audio.length == 0) {
            throw new IllegalArgumentException("audio note bytes are required");
        }
        String type = safe(contentType);
        if (type.isEmpty()) {
            type = "audio/L16; rate=16000; channels=1";
        }
        String responseText = postBytes(apiEndpoint("/v1/audio-notes"), audio, type, metadataHeaders, 60000);
        if (responseText.trim().isEmpty()) {
            return new JSONObject();
        }
        try {
            return new JSONObject(responseText);
        } catch (Exception ignored) {
            // Any 2xx means the note is stored; a non-JSON body is not a failure.
            return new JSONObject();
        }
    }

    // The canonical shared session id every surface joins. Newer gateways expose
    // this; callers must tolerate a 404/absence and keep their local id.
    String defaultSessionId() throws Exception {
        String responseText = getText(apiEndpoint("/v1/sessions/default"), 15000);
        JSONObject response = new JSONObject(responseText);
        return response.optString("session_id", "").trim();
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
        String query = scopedQuery(scope, deviceId);
        String responseText = getText(apiEndpoint("/v1/agent/profile" + query), 15000);
        return new JSONObject(responseText);
    }

    JSONObject activeCompanionPet(String scope, String deviceId) throws Exception {
        String query = scopedQuery(scope, deviceId);
        try {
            JSONObject activePayload = new JSONObject(getText(apiEndpoint("/v1/agent/pets/active" + query), 15000));
            JSONObject active = activeCompanionFromPayload(activePayload);
            if (hasCompanionIdentity(active)) {
                return active;
            }
        } catch (Exception ignored) {
            // Older gateways expose active companion state only through profile/catalog routes.
        }

        JSONObject profilePayload = agentProfile(scope, deviceId);
        JSONObject profileCompanion = activeCompanionFromProfile(profilePayload);
        String companionId = profileCompanion.optString("id", "");
        if (!companionId.isEmpty()) {
            try {
                JSONObject catalogPayload = new JSONObject(getText(apiEndpoint("/v1/agent/pets" + query), 15000));
                JSONObject catalogCompanion = activeCompanionFromPetCatalog(catalogPayload, companionId);
                if (hasCompanionIdentity(catalogCompanion)) {
                    return mergeCompanionMetadata(catalogCompanion, profileCompanion);
                }
            } catch (Exception ignored) {
            }
        }
        return profileCompanion;
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

    JSONObject createMediaBookmark(JSONObject body) throws Exception {
        return new JSONObject(postJson(apiEndpoint("/v1/media/bookmarks"), body.toString(), 15000));
    }

    JSONObject mediaBookmarks() throws Exception {
        return new JSONObject(getText(apiEndpoint("/v1/media/bookmarks?limit=500"), 15000));
    }

    JSONObject resolveMediaBookmark(String query) throws Exception {
        String value = safe(query);
        if (value.isEmpty()) throw new IllegalArgumentException("media bookmark query is required");
        return new JSONObject(getText(
                apiEndpoint("/v1/media/bookmarks?q=" + urlEncode(value)), 15000));
    }

    JSONObject mediaBookmark(String bookmarkId) throws Exception {
        String id = bookmarkPathId(bookmarkId);
        return new JSONObject(getText(apiEndpoint("/v1/media/bookmarks/" + id), 15000));
    }

    JSONObject deleteMediaBookmark(String bookmarkId) throws Exception {
        String id = bookmarkPathId(bookmarkId);
        return new JSONObject(deleteText(apiEndpoint("/v1/media/bookmarks/" + id), 15000));
    }

    private static String bookmarkPathId(String bookmarkId) {
        String id = safe(bookmarkId);
        if (!id.matches("[a-zA-Z0-9_-]{1,120}")) {
            throw new IllegalArgumentException("media bookmark id is invalid");
        }
        return id;
    }

    void downloadLatestAndroidUpdate(File destination) throws Exception {
        downloadFile(apiEndpoint("/v1/android/updates/latest.apk"), destination, 120000);
    }

    // Download a specific rollback release. The URL comes from the update
    // manifest (a proposal), so we only fetch it when it is same-origin with the
    // configured gateway. This keeps a tampered manifest from redirecting the
    // signed-APK download to an arbitrary host; signature + checksum are still
    // verified by the caller before anything is installed.
    void downloadRollbackApk(String downloadUrl, File destination) throws Exception {
        String url = safe(downloadUrl);
        if (url.isEmpty()) {
            throw new IllegalArgumentException("rollback download url is required");
        }
        if (!sameOrigin(baseUrl, url)) {
            throw new IllegalStateException("rollback download host is not the configured gateway");
        }
        downloadFile(url, destination, 120000);
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

    private String postBytes(
            String endpoint,
            byte[] payload,
            String contentType,
            Map<String, String> extraHeaders,
            int readTimeoutMs
    ) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(3500);
        connection.setReadTimeout(readTimeoutMs);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", contentType);
        if (!token.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }
        if (extraHeaders != null) {
            for (Map.Entry<String, String> header : extraHeaders.entrySet()) {
                String name = safe(header.getKey());
                String value = safe(header.getValue());
                if (!name.isEmpty() && !value.isEmpty()) {
                    connection.setRequestProperty(name, value);
                }
            }
        }

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

    private String deleteText(String endpoint, int readTimeoutMs) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setRequestMethod("DELETE");
        connection.setConnectTimeout(3500);
        connection.setReadTimeout(readTimeoutMs);
        if (!token.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }
        int status = connection.getResponseCode();
        String responseText = readStream(status >= 400
                ? connection.getErrorStream() : connection.getInputStream());
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

    private String scopedQuery(String scope, String deviceId) throws Exception {
        String query = "";
        String safeScope = safe(scope);
        String safeDeviceId = safe(deviceId);
        if (!safeScope.isEmpty()) {
            query = "?scope=" + urlEncode(safeScope);
            if (!safeDeviceId.isEmpty()) {
                query += "&device_id=" + urlEncode(safeDeviceId);
            }
        }
        return query;
    }

    private static JSONObject activeCompanionFromPetCatalog(JSONObject payload, String companionId) {
        JSONArray pets = payload == null ? null : payload.optJSONArray("pets");
        if (pets == null) {
            return new JSONObject();
        }
        for (int i = 0; i < pets.length(); i++) {
            JSONObject item = pets.optJSONObject(i);
            if (item == null) {
                continue;
            }
            String id = firstNonEmpty(item.optString("companion_id", ""), item.optString("id", ""));
            if (companionId.equals(id)) {
                return activeCompanionFromPayload(item);
            }
        }
        return new JSONObject();
    }

    private static JSONObject activeCompanionFromProfile(JSONObject payload) {
        JSONObject profile = payload == null ? null : payload.optJSONObject("profile");
        if (profile == null) {
            profile = payload == null ? new JSONObject() : payload;
        }
        JSONObject active = profile.optJSONObject("active_companion");
        JSONObject record = new JSONObject();
        putSafe(record, "id", firstNonEmpty(
                active == null ? "" : active.optString("id", ""),
                profile.optString("active_companion_id", "")));
        putSafe(record, "name", firstNonEmpty(
                active == null ? "" : active.optString("name", ""),
                profile.optString("active_companion_name", ""),
                profile.optString("assistant_name", "")));
        putSafe(record, "source", firstNonEmpty(
                active == null ? "" : active.optString("source", ""),
                profile.optString("active_companion_source", "")));
        putSafe(record, "version", firstNonEmpty(
                active == null ? "" : active.optString("version", ""),
                profile.optString("active_companion_version", "")));
        return record;
    }

    private static JSONObject activeCompanionFromPayload(JSONObject payload) {
        if (payload == null) {
            return new JSONObject();
        }
        JSONObject active = payload.optJSONObject("active_companion");
        JSONObject companion = payload.optJSONObject("companion");
        JSONObject petRecord = payload.optJSONObject("pet");
        JSONObject petSpec = null;
        if (petRecord != null) {
            petSpec = petRecord.optJSONObject("pet");
            if (petSpec == null) {
                petSpec = petRecord;
            }
        }
        JSONObject directPetSpec = payload.optJSONObject("pet_spec");
        if (directPetSpec != null) {
            petSpec = directPetSpec;
        }

        JSONObject record = new JSONObject();
        putSafe(record, "id", firstNonEmpty(
                payload.optString("companion_id", ""),
                payload.optString("id", ""),
                petRecord == null ? "" : petRecord.optString("companion_id", ""),
                companion == null ? "" : companion.optString("id", ""),
                active == null ? "" : active.optString("id", ""),
                payload.optString("active_companion_id", "")));
        putSafe(record, "name", firstNonEmpty(
                payload.optString("companion_name", ""),
                payload.optString("name", ""),
                petRecord == null ? "" : petRecord.optString("companion_name", ""),
                companion == null ? "" : companion.optString("name", ""),
                active == null ? "" : active.optString("name", ""),
                petSpec == null ? "" : petSpec.optString("name", "")));
        putSafe(record, "summary", firstNonEmpty(
                payload.optString("companion_summary", ""),
                payload.optString("summary", ""),
                petRecord == null ? "" : petRecord.optString("companion_summary", ""),
                companion == null ? "" : companion.optString("summary", ""),
                active == null ? "" : active.optString("summary", "")));
        putSafe(record, "palette", firstNonEmpty(
                payload.optString("palette", ""),
                petRecord == null ? "" : petRecord.optString("palette", ""),
                petSpec == null ? "" : petSpec.optString("palette", "")));
        putSafe(record, "motion", firstNonEmpty(
                payload.optString("motion", ""),
                petRecord == null ? "" : petRecord.optString("motion", ""),
                petSpec == null ? "" : petSpec.optString("motion", "")));
        putSafe(record, "renderer", petSpec == null ? "" : petSpec.optString("renderer", ""));
        putSafe(record, "source", firstNonEmpty(
                payload.optString("source", ""),
                petRecord == null ? "" : petRecord.optString("source", ""),
                companion == null ? "" : companion.optString("source", ""),
                active == null ? "" : active.optString("source", "")));
        putSafe(record, "version", firstNonEmpty(
                payload.optString("version", ""),
                petRecord == null ? "" : petRecord.optString("version", ""),
                companion == null ? "" : companion.optString("version", ""),
                active == null ? "" : active.optString("version", "")));
        return record;
    }

    private static JSONObject mergeCompanionMetadata(JSONObject primary, JSONObject fallback) {
        JSONObject merged = new JSONObject();
        putSafe(merged, "id", firstNonEmpty(primary.optString("id", ""), fallback.optString("id", "")));
        putSafe(merged, "name", firstNonEmpty(primary.optString("name", ""), fallback.optString("name", "")));
        putSafe(merged, "summary", firstNonEmpty(primary.optString("summary", ""), fallback.optString("summary", "")));
        putSafe(merged, "palette", firstNonEmpty(primary.optString("palette", ""), fallback.optString("palette", "")));
        putSafe(merged, "motion", firstNonEmpty(primary.optString("motion", ""), fallback.optString("motion", "")));
        putSafe(merged, "renderer", firstNonEmpty(primary.optString("renderer", ""), fallback.optString("renderer", "")));
        putSafe(merged, "source", firstNonEmpty(primary.optString("source", ""), fallback.optString("source", "")));
        putSafe(merged, "version", firstNonEmpty(primary.optString("version", ""), fallback.optString("version", "")));
        return merged;
    }

    private static boolean hasCompanionIdentity(JSONObject record) {
        return record != null
                && (!safe(record.optString("id", "")).isEmpty()
                || !safe(record.optString("name", "")).isEmpty());
    }

    private static void putSafe(JSONObject target, String key, String value) {
        String safeValue = safe(value);
        if (safeValue.isEmpty()) {
            return;
        }
        try {
            target.put(key, safeValue);
        } catch (Exception ignored) {
        }
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) {
            return "";
        }
        for (String value : values) {
            String item = safe(value);
            if (!item.isEmpty()) {
                return item;
            }
        }
        return "";
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

    private static boolean sameOrigin(String a, String b) {
        try {
            java.net.URI ua = java.net.URI.create(safe(a));
            java.net.URI ub = java.net.URI.create(safe(b));
            return ua.getScheme() != null
                    && ua.getScheme().equalsIgnoreCase(ub.getScheme())
                    && ua.getHost() != null
                    && ua.getHost().equalsIgnoreCase(ub.getHost())
                    && normalizedPort(ua) == normalizedPort(ub);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static int normalizedPort(java.net.URI uri) {
        if (uri.getPort() != -1) {
            return uri.getPort();
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(java.util.Locale.US);
        if ("https".equals(scheme)) {
            return 443;
        }
        if ("http".equals(scheme)) {
            return 80;
        }
        return -1;
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
        // True when the gateway did not persist this turn (incognito context).
        final boolean notSaved;

        GatewayTextResponse(String text, String conversationId) {
            this(text, conversationId, false);
        }

        GatewayTextResponse(String text, String conversationId, boolean notSaved) {
            this.text = text;
            this.conversationId = conversationId == null ? "" : conversationId.trim();
            this.notSaved = notSaved;
        }
    }
}
