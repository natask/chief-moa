package ag.companion;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Device-scoped client for named development requests. It has no progress or execution authority. */
final class MoaDevelopmentRequestsClient {
    private static final String PATH = "/v1/development-requests";
    private static final int MAX_BYTES = 1024 * 1024;
    private final String origin;
    private final String credential;
    private final String deviceId;

    MoaDevelopmentRequestsClient(String origin, String credential, String deviceId) {
        this.origin = requireOrigin(origin);
        this.credential = safe(credential);
        this.deviceId = safe(deviceId);
        if (this.credential.isEmpty() || this.deviceId.isEmpty()) {
            throw new IllegalArgumentException("connected device credential is required");
        }
    }

    JSONObject list() throws Exception { return request("GET", PATH + "?limit=20", null); }

    JSONObject create(String name, String request, String idempotencyKey) throws Exception {
        JSONObject body = new JSONObject()
                .put("display_name", required(name, "name"))
                .put("source_text", required(request, "request"))
                .put("project_id", "chief-moa")
                .put("idempotency_key", required(idempotencyKey, "idempotency key"))
                .put("provenance", new JSONObject()
                        .put("kind", "text")
                        .put("surface", "android"));
        return request("POST", PATH, body);
    }

    private JSONObject request(String method, String path, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Authorization", "Device " + credential);
        connection.setRequestProperty("X-Moa-Device-Id", deviceId);
        connection.setRequestProperty("X-Moa-Surface", "android");
        if (body != null) {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
        }
        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String text;
        try (InputStream input = stream) { text = input == null ? "" : read(input); }
        finally { connection.disconnect(); }
        if (status < 200 || status >= 300) throw new HttpError(status, text);
        return text.trim().isEmpty() ? new JSONObject() : new JSONObject(text);
    }

    private static String read(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int count;
        while ((count = input.read(buffer)) >= 0) {
            total += count;
            if (total > MAX_BYTES) throw new IllegalStateException("development request response is too large");
            output.write(buffer, 0, count);
        }
        return output.toString(StandardCharsets.UTF_8.name());
    }

    private static String requireOrigin(String value) {
        String result = safe(value);
        try {
            URI uri = URI.create(result);
            boolean local = "http".equalsIgnoreCase(uri.getScheme())
                    && ("localhost".equalsIgnoreCase(uri.getHost()) || "127.0.0.1".equals(uri.getHost()));
            if (!("https".equalsIgnoreCase(uri.getScheme()) || local) || uri.getQuery() != null
                    || uri.getFragment() != null || uri.getUserInfo() != null) throw new IllegalArgumentException();
            while (result.endsWith("/")) result = result.substring(0, result.length() - 1);
            return result;
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("valid HTTPS gateway is required");
        }
    }

    private static String required(String value, String label) {
        String result = safe(value);
        if (result.isEmpty()) throw new IllegalArgumentException(label + " is required");
        return result;
    }

    private static String safe(Object value) { return value == null ? "" : String.valueOf(value).trim(); }

    static final class HttpError extends Exception {
        final int status;
        HttpError(int status, String body) {
            super("HTTP " + status + (safe(body).isEmpty() ? "" : " " + safe(body)));
            this.status = status;
        }
    }
}
