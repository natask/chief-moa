package ag.companion;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Read/download-only transport for rescue; it exposes no release mutation method. */
final class MoaReleaseRecoveryClient {
    private static final int MAX_RESPONSE_BYTES = 1024 * 1024;
    private final String origin;
    private final String token;
    private final String deviceId;

    MoaReleaseRecoveryClient(String origin, String token, String deviceId) {
        this.origin = normalize(origin);
        this.token = safe(token);
        this.deviceId = safe(deviceId);
        if (this.deviceId.isEmpty()) throw new IllegalArgumentException("device id is required");
    }

    JSONObject view() throws Exception {
        String path = "/v1/release-recovery/manifest";
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(3500);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("X-Moa-Device-Id", deviceId);
        connection.setRequestProperty("X-Moa-Surface", "android");
        String authorization = MoaGatewayAuthorization.headerValue(token);
        if (!authorization.isEmpty()) connection.setRequestProperty("Authorization", authorization);
        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String text;
        try (InputStream input = stream) {
            text = input == null ? "" : read(input);
        } finally {
            connection.disconnect();
        }
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("HTTP " + status + " reading release recovery");
        }
        return new JSONObject(text);
    }

    void download(MoaReleaseRescueCache.Entry entry, File destination) throws Exception {
        if (entry == null) throw new IllegalArgumentException("release entry is required");
        download(entry.downloadUrl, entry.sizeBytes, destination);
    }

    void download(MoaForwardRecoveryManifest recovery, File destination) throws Exception {
        if (recovery == null) throw new IllegalArgumentException("forward recovery is required");
        download(recovery.downloadUrl, recovery.artifactSizeBytes, destination);
    }

    private void download(String url, long sizeBytes, File destination) throws Exception {
        new MoaReleaseControlClient(origin, token).downloadArtifact(url, sizeBytes, destination);
    }

    private static String read(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int count;
        while ((count = input.read(buffer)) >= 0) {
            total += count;
            if (total > MAX_RESPONSE_BYTES) {
                throw new IllegalStateException("release recovery response is too large");
            }
            output.write(buffer, 0, count);
        }
        return output.toString(StandardCharsets.UTF_8.name());
    }

    private static String normalize(String value) {
        String result = safe(value);
        while (result.endsWith("/")) result = result.substring(0, result.length() - 1);
        if (!(result.startsWith("https://") || result.startsWith("http://"))) {
            throw new IllegalArgumentException("release recovery origin is invalid");
        }
        return result;
    }

    private static String safe(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }
}
