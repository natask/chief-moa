package ai.moa.assistant;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.UUID;
import java.util.regex.Pattern;

/** Narrow HTTP client for the release-control projection exposed by the gateway. */
final class MoaReleaseControlClient {
    private static final String BASE_PATH = "/v1/release-control/apps/chief-moa";
    private static final String REGISTRATION_PATH = "/v1/device-credentials/registrations";
    private static final String SURFACE = "android";
    private static final int MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
    private static final Pattern DEVICE_TOKEN =
            Pattern.compile("^moa_dev_v1\\.[A-Za-z0-9_-]{43}$");
    private final String baseUrl;
    private final String gatewayToken;
    private final String deviceId;
    private final DeviceCredentialState credentialState;

    MoaReleaseControlClient(String baseUrl, String token) {
        this(baseUrl, token, "", null);
    }

    MoaReleaseControlClient(
            String baseUrl, String token, String deviceId,
            DeviceCredentialState credentialState) {
        this.baseUrl = normalizeBase(baseUrl);
        this.gatewayToken = safe(token);
        this.deviceId = safe(deviceId).toLowerCase();
        this.credentialState = credentialState;
        if (credentialState != null) requireSecureCredentialOrigin(this.baseUrl);
    }

    JSONObject view(String deviceId) throws Exception {
        requireConfiguredDevice(deviceId);
        return releaseJson("GET", BASE_PATH + "/view?device_id=" + encode(deviceId)
                + "&surface=android", null);
    }

    JSONObject candidates(String cursor, int limit) throws Exception {
        if (limit < 1 || limit > 100) throw new IllegalArgumentException("candidate page limit is invalid");
        String path = BASE_PATH + "/candidates?limit=" + limit;
        if (!safe(cursor).isEmpty()) path += "&cursor=" + encode(cursor);
        return releaseJson("GET", path, null);
    }

    JSONObject selectCandidate(JSONObject body) throws Exception {
        return releaseJson("POST", BASE_PATH + "/candidate-selections", body);
    }

    JSONObject assign(JSONObject body) throws Exception {
        return releaseJson("POST", BASE_PATH + "/assignments", body);
    }

    JSONObject fallback(JSONObject body) throws Exception {
        return releaseJson("POST", BASE_PATH + "/fallback", body);
    }

    JSONObject installReceipt(JSONObject body) throws Exception {
        return releaseJson("POST", BASE_PATH + "/install-receipts", body);
    }

    JSONObject feedback(JSONObject body) throws Exception {
        return releaseJson("POST", BASE_PATH + "/feedback", body);
    }

    JSONObject createModificationRequest(JSONObject body) throws Exception {
        return releaseJson("POST", BASE_PATH + "/modification-requests", body);
    }

    JSONObject modificationRequest(String requestId) throws Exception {
        if (!safe(requestId).matches("[A-Za-z0-9._:-]{1,160}")) {
            throw new IllegalArgumentException("modification request id is invalid");
        }
        return releaseJson("GET", BASE_PATH + "/modification-requests/" + encode(requestId), null);
    }

    void downloadArtifact(String downloadUrl, long expectedSize, File destination) throws Exception {
        if (expectedSize <= 0L) throw new IllegalArgumentException("artifact size is invalid");
        URL target = new URL(safe(downloadUrl));
        boolean gatewayOrigin = sameOrigin(baseUrl, target.toString());
        if (!gatewayOrigin && !"https".equalsIgnoreCase(target.getProtocol())) {
            throw new IllegalStateException("external release artifact must use HTTPS");
        }
        HttpURLConnection connection = (HttpURLConnection) target.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(120000);
        if (gatewayOrigin && !gatewayToken.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + gatewayToken);
        }
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            connection.disconnect();
            throw new IllegalStateException("HTTP " + status + " downloading release artifact");
        }
        File temporary = new File(destination.getParentFile(), destination.getName() + ".part");
        if (temporary.exists() && !temporary.delete()) {
            connection.disconnect();
            throw new IllegalStateException("stale artifact temporary file cannot be removed");
        }
        long written = 0L;
        try {
            try (InputStream input = connection.getInputStream();
                 OutputStream output = new FileOutputStream(temporary, false)) {
                byte[] buffer = new byte[16 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    written += read;
                    if (written > expectedSize) {
                        throw new IllegalStateException("release artifact exceeds declared size");
                    }
                    output.write(buffer, 0, read);
                }
            }
        } catch (Exception error) {
            temporary.delete();
            throw error;
        } finally {
            connection.disconnect();
        }
        if (written != expectedSize) {
            temporary.delete();
            throw new IllegalStateException("release artifact size mismatch");
        }
        if (destination.exists() && !destination.delete()) {
            temporary.delete();
            throw new IllegalStateException("prior release artifact cannot be replaced");
        }
        if (!temporary.renameTo(destination)) {
            temporary.delete();
            throw new IllegalStateException("release artifact cannot be finalized");
        }
    }

    private JSONObject releaseJson(String method, String path, JSONObject body) throws Exception {
        DeviceCredential credential = ensureRegistered(false);
        try {
            return json(method, path, body, "Device " + credential.token, true);
        } catch (HttpStatusException error) {
            if (error.status != 401) throw error;
            credential = ensureRegistered(true);
            return json(method, path, body, "Device " + credential.token, true);
        }
    }

    private DeviceCredential ensureRegistered(boolean force) throws Exception {
        if (credentialState == null || deviceId.isEmpty()) {
            throw new IllegalStateException("release-control device credential is not configured");
        }
        DeviceCredential credential = credentialState.load(baseUrl, deviceId, SURFACE);
        if (credential == null) {
            byte[] bytes = new byte[32];
            new SecureRandom().nextBytes(bytes);
            credential = new DeviceCredential(
                    "moa_dev_v1." + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes),
                    "device-register-" + UUID.randomUUID(), false);
            credentialState.save(baseUrl, deviceId, SURFACE, credential);
        }
        validateCredential(credential);
        if (!credential.registered || force) {
            if (gatewayToken.isEmpty()) {
                throw new IllegalStateException("gateway bearer token is required to register this device");
            }
            JSONObject response = json(
                    "POST", REGISTRATION_PATH,
                    new JSONObject()
                            .put("device_id", deviceId)
                            .put("surface_id", SURFACE)
                            .put("idempotency_key", credential.idempotencyKey)
                            .put("credential_token", credential.token),
                    "Bearer " + gatewayToken, false);
            JSONObject receipt = response.optJSONObject("registration_receipt");
            if (response.optInt("schema_version", 0) != 1 || receipt == null
                    || !deviceId.equals(safe(receipt.optString("device_id")).toLowerCase())
                    || !SURFACE.equals(safe(receipt.optString("surface_id")).toLowerCase())
                    || !"active".equals(safe(receipt.optString("status")).toLowerCase())) {
                throw new IllegalStateException("device registration returned an invalid receipt");
            }
            credential = new DeviceCredential(credential.token, credential.idempotencyKey, true);
            credentialState.save(baseUrl, deviceId, SURFACE, credential);
        }
        return credential;
    }

    private JSONObject json(
            String method, String path, JSONObject body,
            String authorization, boolean assertDevice) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod(method);
        connection.setConnectTimeout(3500);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept", "application/json");
        if (!safe(authorization).isEmpty()) {
            connection.setRequestProperty("Authorization", authorization);
        }
        if (assertDevice) {
            connection.setRequestProperty("X-Moa-Device-Id", deviceId);
            connection.setRequestProperty("X-Moa-Surface", SURFACE);
        }
        if (body != null) {
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setFixedLengthStreamingMode(payload.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(payload);
            }
        }
        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String text;
        try (InputStream input = stream) {
            text = input == null ? "" : readBoundedUtf8(input);
        } finally {
            connection.disconnect();
        }
        if (status < 200 || status >= 300) {
            throw new HttpStatusException(status,
                    "HTTP " + status + (text.isEmpty() ? "" : " " + text));
        }
        return text.trim().isEmpty() ? new JSONObject() : new JSONObject(text);
    }

    private static String readBoundedUtf8(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8 * 1024];
        int read;
        int total = 0;
        while ((read = input.read(buffer)) >= 0) {
            total += read;
            if (total > MAX_JSON_RESPONSE_BYTES) {
                throw new IllegalStateException("release-control JSON response exceeds size limit");
            }
            output.write(buffer, 0, read);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }

    private static boolean sameOrigin(String left, String right) {
        try {
            URI a = new URI(left);
            URI b = new URI(right);
            return safe(a.getScheme()).equalsIgnoreCase(safe(b.getScheme()))
                    && safe(a.getHost()).equalsIgnoreCase(safe(b.getHost()))
                    && effectivePort(a) == effectivePort(b);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static int effectivePort(URI uri) {
        if (uri.getPort() >= 0) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private static String normalizeBase(String value) {
        String base = safe(value);
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        if (base.endsWith("/v1/chat")) base = base.substring(0, base.length() - "/v1/chat".length());
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            throw new IllegalArgumentException("gateway URL must use http(s)");
        }
        return base;
    }

    private static void requireSecureCredentialOrigin(String value) {
        try {
            URI uri = new URI(value);
            if (uri.getRawUserInfo() != null) {
                throw new IllegalArgumentException(
                        "release-control gateway URL must not contain user information");
            }
            String scheme = safe(uri.getScheme()).toLowerCase();
            String host = safe(uri.getHost()).toLowerCase();
            boolean loopback = "localhost".equals(host)
                    || "127.0.0.1".equals(host)
                    || "::1".equals(host)
                    || "[::1]".equals(host);
            if (!"https".equals(scheme) && !("http".equals(scheme) && loopback)) {
                throw new IllegalArgumentException(
                        "release-control device credentials require HTTPS except on loopback");
            }
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("release-control gateway URL is invalid");
        }
    }

    private static String encode(String value) throws Exception {
        return URLEncoder.encode(safe(value), StandardCharsets.UTF_8.name());
    }

    private static String safe(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }

    private void requireConfiguredDevice(String requested) {
        if (credentialState == null || deviceId.isEmpty()
                || !deviceId.equals(safe(requested).toLowerCase())) {
            throw new IllegalStateException("release-control device identity is not configured");
        }
    }

    private static void validateCredential(DeviceCredential credential) {
        if (!DEVICE_TOKEN.matcher(safe(credential.token)).matches()
                || safe(credential.idempotencyKey).length() < 16
                || safe(credential.idempotencyKey).length() > 128) {
            throw new IllegalStateException("stored release-control device credential is invalid");
        }
    }

    interface DeviceCredentialState {
        DeviceCredential load(String origin, String deviceId, String surfaceId);
        void save(String origin, String deviceId, String surfaceId, DeviceCredential credential);
    }

    static final class DeviceCredential {
        final String token;
        final String idempotencyKey;
        final boolean registered;

        DeviceCredential(String token, String idempotencyKey, boolean registered) {
            this.token = safe(token);
            this.idempotencyKey = safe(idempotencyKey);
            this.registered = registered;
        }
    }

    private static final class HttpStatusException extends IllegalStateException {
        final int status;

        HttpStatusException(int status, String message) {
            super(message);
            this.status = status;
        }
    }
}
