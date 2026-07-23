package ai.moa.assistant;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/** Narrow HTTP client for the release-control projection exposed by the gateway. */
final class MoaReleaseControlClient {
    private static final String BASE_PATH = "/v1/release-control/apps/chief-moa";
    private final String baseUrl;
    private final String token;

    MoaReleaseControlClient(String baseUrl, String token) {
        this.baseUrl = normalizeBase(baseUrl);
        this.token = safe(token);
    }

    JSONObject view(String deviceId) throws Exception {
        return json("GET", BASE_PATH + "/view?device_id=" + encode(deviceId)
                + "&surface=android", null);
    }

    JSONObject assign(JSONObject body) throws Exception {
        return json("POST", BASE_PATH + "/assignments", body);
    }

    JSONObject fallback(JSONObject body) throws Exception {
        return json("POST", BASE_PATH + "/fallback", body);
    }

    JSONObject installReceipt(JSONObject body) throws Exception {
        return json("POST", BASE_PATH + "/install-receipts", body);
    }

    JSONObject feedback(JSONObject body) throws Exception {
        return json("POST", BASE_PATH + "/feedback", body);
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
        if (gatewayOrigin && !token.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
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

    private JSONObject json(String method, String path, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod(method);
        connection.setConnectTimeout(3500);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept", "application/json");
        if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
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
            text = input == null ? "" : new String(input.readAllBytes(), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("HTTP " + status + (text.isEmpty() ? "" : " " + text));
        }
        return text.trim().isEmpty() ? new JSONObject() : new JSONObject(text);
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

    private static String encode(String value) throws Exception {
        return URLEncoder.encode(safe(value), StandardCharsets.UTF_8.name());
    }

    private static String safe(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }
}
