package ag.companion;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/** Exchanges a one-use enrollment capability without handling an owner bearer token. */
final class AgEnrollmentClient {
    private static final Pattern CAPABILITY = Pattern.compile("^ag_enroll_v1\\.[A-Za-z0-9_-]{43}$");
    private static final Pattern CREDENTIAL = Pattern.compile("^ag_dev_v1\\.[A-Za-z0-9_-]{43}$");
    private static final Set<String> REQUIRED_SCOPES = Set.of(
            "continuity.read", "conversation.read", "conversation.write", "profile.read");
    private final String origin;
    private final SecureRandom random;
    private final Transport transport;

    AgEnrollmentClient(String origin) {
        this(origin, new SecureRandom(), null);
    }

    AgEnrollmentClient(String origin, SecureRandom random) {
        this(origin, random, null);
    }

    AgEnrollmentClient(String origin, SecureRandom random, Transport transport) {
        this.origin = requireOrigin(origin);
        this.random = random == null ? new SecureRandom() : random;
        this.transport = transport == null ? this::httpRequest : transport;
    }

    Result exchangeAndDiscover(String capability, MoaDeviceCredentialStore store,
            String deviceId) throws Exception {
        String boundedCapability = safe(capability);
        if (!CAPABILITY.matcher(boundedCapability).matches()) {
            throw new IllegalArgumentException("Enter the complete Ag enrollment code");
        }
        String credential = newCredential();
        JSONObject exchange = transport.request("POST", "/v1/device-enrollments/exchanges",
                new JSONObject().put("enrollment_capability", boundedCapability)
                        .put("credential_token", credential), "");
        JSONObject issued = exchange.optJSONObject("device_credential");
        validateIssued(issued, deviceId);
        store.saveEnrollmentCredential(origin, deviceId, credential, false, "");
        Result result = discover(credential, deviceId);
        store.saveEnrollmentCredential(origin, deviceId, credential, true, result.accountId);
        return result;
    }

    Result discover(String credential, String deviceId) throws Exception {
        if (!CREDENTIAL.matcher(safe(credential)).matches()) {
            throw new IllegalStateException("stored Ag device credential is invalid");
        }
        JSONObject continuity = transport.request("GET", "/v1/device-enrollments/continuity", null,
                "Device " + credential);
        if (continuity.optInt("schema_version") != 1
                || continuity.optBoolean("local_state_transferred", true)
                || safe(continuity.optString("account_id")).isEmpty()) {
            throw new IllegalStateException("gateway continuity response was not verifiable");
        }
        Set<String> restore = strings(continuity.optJSONArray("restore"));
        if (!restore.containsAll(Set.of("conversations", "sessions", "runs", "profile"))) {
            throw new IllegalStateException("gateway continuity response was incomplete");
        }
        return new Result(continuity.optString("account_id"), continuity.optString("tenant_id"), restore);
    }

    private void validateIssued(JSONObject issued, String deviceId) {
        if (issued == null || !safe(deviceId).equals(safe(issued.optString("device_id")))
                || !"android".equals(issued.optString("surface_id"))
                || !"ag.companion".equals(issued.optString("application_id"))) {
            throw new IllegalStateException("enrollment response did not match this Ag device");
        }
        if (!strings(issued.optJSONArray("scopes")).containsAll(REQUIRED_SCOPES)) {
            throw new IllegalStateException("enrollment response omitted required device scopes");
        }
    }

    private String newCredential() {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        return "ag_dev_v1." + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private JSONObject httpRequest(String method, String path, JSONObject body, String authorization) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(8_000);
        connection.setReadTimeout(8_000);
        connection.setRequestProperty("Accept", "application/json");
        if (!authorization.isEmpty()) connection.setRequestProperty("Authorization", authorization);
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
        }
        int status = connection.getResponseCode();
        String text = read(status >= 200 && status < 300
                ? connection.getInputStream() : connection.getErrorStream());
        if (status < 200 || status >= 300) {
            String code = "enrollment_failed";
            try { code = new JSONObject(text).optString("error", code); } catch (Exception ignored) { }
            throw new IllegalStateException(code);
        }
        return new JSONObject(text);
    }

    private static String requireOrigin(String value) {
        String origin = safe(value);
        try {
            URI uri = URI.create(origin);
            boolean secure = "https".equalsIgnoreCase(uri.getScheme());
            boolean loopback = "http".equalsIgnoreCase(uri.getScheme())
                    && ("localhost".equalsIgnoreCase(uri.getHost()) || "127.0.0.1".equals(uri.getHost()));
            if ((!secure && !loopback) || uri.getUserInfo() != null || uri.getQuery() != null
                    || uri.getFragment() != null || (uri.getPath() != null && !uri.getPath().isEmpty() && !"/".equals(uri.getPath()))) {
                throw new IllegalArgumentException("Ag enrollment requires an HTTPS gateway origin");
            }
            return origin.endsWith("/") ? origin.substring(0, origin.length() - 1) : origin;
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("Ag enrollment requires an HTTPS gateway origin");
        }
    }

    private static Set<String> strings(JSONArray values) {
        Set<String> result = new HashSet<>();
        if (values != null) for (int i = 0; i < values.length(); i++) result.add(safe(values.optString(i)));
        return result;
    }

    private static String read(InputStream input) throws Exception {
        if (input == null) return "";
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) result.append(line);
        }
        return result.toString();
    }

    private static String safe(Object value) { return value == null ? "" : String.valueOf(value).trim(); }

    static final class Result {
        final String accountId;
        final String tenantId;
        final Set<String> restore;
        Result(String accountId, String tenantId, Set<String> restore) {
            this.accountId = accountId;
            this.tenantId = tenantId;
            this.restore = Set.copyOf(restore);
        }
    }

    interface Transport {
        JSONObject request(String method, String path, JSONObject body, String authorization) throws Exception;
    }
}
