package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaReleaseControlClientTest {
    private ServerSocket server;
    private Thread worker;
    private volatile boolean running;
    private String baseUrl;
    private final AtomicReference<String> target = new AtomicReference<>("");
    private final AtomicReference<String> authorization = new AtomicReference<>("");
    private final AtomicReference<String> assertedDevice = new AtomicReference<>("");
    private final AtomicReference<String> assertedSurface = new AtomicReference<>("");
    private final MemoryCredentialState credentials = new MemoryCredentialState();

    @Before
    public void setUp() throws Exception {
        server = new ServerSocket(0);
        running = true;
        worker = new Thread(this::serve, "release-client-test-server");
        worker.start();
        baseUrl = "http://127.0.0.1:" + server.getLocalPort();
    }

    @After
    public void tearDown() throws Exception {
        running = false;
        if (server != null) server.close();
        if (worker != null) worker.join(1000);
    }

    @Test
    public void viewRegistersThenUsesDeviceCredentialAndAssertions() throws Exception {
        JSONObject response = client().view("android_1");

        assertEquals(1, response.getInt("schema_version"));
        assertEquals(
                "/v1/release-control/apps/chief-moa/view?device_id=android_1&surface=android",
                target.get());
        assertTrue(authorization.get().startsWith("Device moa_dev_v1."));
        assertEquals("android_1", assertedDevice.get());
        assertEquals("android", assertedSurface.get());
        assertTrue(credentials.value.registered);
    }

    @Test
    public void authenticatedJsonRedirectIsRejected() throws Exception {
        try {
            client()
                    .feedback(new JSONObject().put("redirect", true));
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("HTTP 302"));
            return;
        }
        throw new AssertionError("Expected redirect rejection");
    }

    @Test
    public void candidateCatalogEncodesCursorAndExactSelectionUsesNewRoutes() throws Exception {
        client().candidates("bundle:a", 50);
        assertEquals("/v1/release-control/apps/chief-moa/candidates?limit=50&cursor=bundle%3Aa",
                target.get());
        client().selectCandidate(new JSONObject().put("bundle_id", "bundle-a"));
        assertEquals("/v1/release-control/apps/chief-moa/candidate-selections", target.get());
    }

    @Test
    public void modificationRequestsUseSeparateExplicitRoutes() throws Exception {
        client().createModificationRequest(new JSONObject().put("feedback_id", "feedback-1"));
        assertEquals("/v1/release-control/apps/chief-moa/modification-requests", target.get());
        client().modificationRequest("request:1");
        assertEquals("/v1/release-control/apps/chief-moa/modification-requests/request%3A1", target.get());
    }

    @Test
    public void artifactDownloadIsExactSizeAndLeavesNoPartialFile() throws Exception {
        File dir = Files.createTempDirectory("moa-release-client").toFile();
        File destination = new File(dir, "release.apk");
        try {
            MoaReleaseControlClient client = new MoaReleaseControlClient(baseUrl, "secret");
            client.downloadArtifact(baseUrl + "/artifact.apk", 3L, destination);
            assertEquals("apk", new String(Files.readAllBytes(destination.toPath()), StandardCharsets.UTF_8));

            try {
                client.downloadArtifact(baseUrl + "/artifact.apk", 2L, destination);
            } catch (IllegalStateException expected) {
                assertTrue(expected.getMessage().contains("declared size"));
            }
            assertFalse(new File(dir, "release.apk.part").exists());
        } finally {
            destination.delete();
            dir.delete();
        }
    }

    @Test
    public void credentialAwareClientRejectsRemotePlaintextAndUrlUserInfo() {
        try {
            new MoaReleaseControlClient(
                    "http://api.agee.app", "secret", "android_1", credentials);
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("require HTTPS"));
            try {
                new MoaReleaseControlClient(
                        "https://user:password@api.agee.app",
                        "secret", "android_1", credentials);
            } catch (IllegalArgumentException userInfo) {
                assertTrue(userInfo.getMessage().contains("user information"));
                return;
            }
            throw new AssertionError("Expected URL user information rejection");
        }
        throw new AssertionError("Expected remote plaintext rejection");
    }

    @Test
    public void legacyDownloadClientMayRetainExplicitRemoteHttpCompatibility() {
        new MoaReleaseControlClient("http://example.test", "secret");
    }

    private void serve() {
        while (running) {
            try (Socket socket = server.accept()) {
                handle(socket);
            } catch (Exception ignored) {
                if (!running) return;
            }
        }
    }

    private void handle(Socket socket) throws Exception {
        InputStream input = socket.getInputStream();
        ByteArrayOutputStream headers = new ByteArrayOutputStream();
        int matched = 0;
        while (matched < 4) {
            int next = input.read();
            if (next < 0) return;
            headers.write(next);
            byte[] end = {'\r', '\n', '\r', '\n'};
            matched = next == end[matched] ? matched + 1 : (next == '\r' ? 1 : 0);
        }
        String headerText = headers.toString(StandardCharsets.UTF_8.name());
        String[] lines = headerText.split("\\r\\n");
        target.set(lines[0].split(" ")[1]);
        int length = 0;
        authorization.set("");
        assertedDevice.set("");
        assertedSurface.set("");
        for (String line : lines) {
            if (line.toLowerCase().startsWith("authorization:")) {
                authorization.set(line.substring(line.indexOf(':') + 1).trim());
            } else if (line.toLowerCase().startsWith("content-length:")) {
                length = Integer.parseInt(line.substring(line.indexOf(':') + 1).trim());
            } else if (line.toLowerCase().startsWith("x-moa-device-id:")) {
                assertedDevice.set(line.substring(line.indexOf(':') + 1).trim());
            } else if (line.toLowerCase().startsWith("x-moa-surface:")) {
                assertedSurface.set(line.substring(line.indexOf(':') + 1).trim());
            }
        }
        byte[] body = input.readNBytes(length);
        String request = new String(body, StandardCharsets.UTF_8);
        if (target.get().equals("/v1/device-credentials/registrations")) {
            JSONObject registration = new JSONObject(request);
            assertEquals("Bearer secret", authorization.get());
            assertEquals("android_1", registration.getString("device_id"));
            assertEquals("android", registration.getString("surface_id"));
            assertTrue(registration.getString("credential_token").startsWith("moa_dev_v1."));
            respond(socket, 201, "Created",
                    "{\"schema_version\":1,\"registration_receipt\":{"
                            + "\"credential_id\":\"devc_test\",\"device_id\":\"android_1\","
                            + "\"surface_id\":\"android\",\"status\":\"active\","
                            + "\"created_at\":\"2026-07-23T00:00:00Z\"}}", "");
        } else if (target.get().equals("/artifact.apk")) {
            respond(socket, 200, "OK", "apk", "");
        } else if (request.contains("\"redirect\":true")) {
            respond(socket, 302, "Found", "", "Location: " + baseUrl + "/redirect-target\r\n");
        } else {
            respond(socket, 200, "OK", "{\"schema_version\":1}", "");
        }
    }

    private MoaReleaseControlClient client() {
        return new MoaReleaseControlClient(baseUrl, "secret", "android_1", credentials);
    }

    private static final class MemoryCredentialState
            implements MoaReleaseControlClient.DeviceCredentialState {
        MoaReleaseControlClient.DeviceCredential value;

        @Override
        public MoaReleaseControlClient.DeviceCredential load(
                String origin, String deviceId, String surfaceId) {
            return value;
        }

        @Override
        public void save(
                String origin, String deviceId, String surfaceId,
                MoaReleaseControlClient.DeviceCredential credential) {
            value = credential;
        }
    }

    private static void respond(
            Socket socket, int status, String reason, String body, String extraHeaders) throws Exception {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String headers = "HTTP/1.1 " + status + " " + reason + "\r\n"
                + "Content-Type: application/json\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + extraHeaders
                + "Connection: close\r\n\r\n";
        OutputStream output = socket.getOutputStream();
        output.write(headers.getBytes(StandardCharsets.UTF_8));
        output.write(bytes);
        output.flush();
    }
}
