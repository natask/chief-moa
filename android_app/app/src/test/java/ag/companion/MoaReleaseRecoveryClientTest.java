package ag.companion;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

public final class MoaReleaseRecoveryClientTest {
    private static final String DEVICE_TOKEN = "ag_dev_v1." + "a".repeat(43);
    private ServerSocket server;
    private Thread worker;
    private volatile boolean running;
    private String baseUrl;
    private final AtomicReference<String> target = new AtomicReference<>("");
    private final AtomicReference<String> authorization = new AtomicReference<>("");
    private final AtomicReference<String> assertedDevice = new AtomicReference<>("");
    private final AtomicReference<String> assertedSurface = new AtomicReference<>("");

    @Before
    public void setUp() throws Exception {
        server = new ServerSocket(0);
        running = true;
        worker = new Thread(this::serve, "release-recovery-client-test-server");
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
    public void manifestUsesDedicatedIdentityFreeRecoveryContract() throws Exception {
        JSONObject payload = new MoaReleaseRecoveryClient(
                baseUrl, DEVICE_TOKEN, "android_phone_1").view();
        MoaReleaseSelectionPolicy.View view = MoaReleaseSelectionPolicy.parseView(payload);

        assertEquals("/v1/release-recovery/manifest", target.get());
        assertEquals("Device " + DEVICE_TOKEN, authorization.get());
        assertEquals("android_phone_1", assertedDevice.get());
        assertEquals("android", assertedSurface.get());
        assertNotNull(view.stable);
        assertNotNull(view.preview);
        assertEquals("stable-12", view.stable.releaseId);
        assertEquals("https://gateway.test/v1/release-recovery/artifacts/stable-12.apk",
                view.stable.artifact.downloadUrl);
        assertEquals("b".repeat(64), view.stable.artifact.sha256);
        assertEquals(4096L, view.stable.artifact.sizeBytes);
        assertEquals(12L, view.stable.artifact.versionCode);
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
        String[] lines = headers.toString(StandardCharsets.UTF_8.name()).split("\\r\\n");
        target.set(lines[0].split(" ")[1]);
        for (String line : lines) {
            String lower = line.toLowerCase();
            if (lower.startsWith("authorization:")) {
                authorization.set(line.substring(line.indexOf(':') + 1).trim());
            } else if (lower.startsWith("x-moa-device-id:")) {
                assertedDevice.set(line.substring(line.indexOf(':') + 1).trim());
            } else if (lower.startsWith("x-moa-surface:")) {
                assertedSurface.set(line.substring(line.indexOf(':') + 1).trim());
            }
        }
        respond(socket, manifest().toString());
    }

    private static JSONObject manifest() throws Exception {
        JSONObject stable = candidate("stable", "stable-12", "stable-bundle", 12L, "1.2.0");
        JSONObject preview = candidate("preview", "trial-13", "trial-bundle", 13L, "1.3.0");
        return new JSONObject("{\"schema_version\":1,\"application_id\":\"chief-moa\","
                + "\"device_id\":\"android_phone_1\",\"channels\":{},\"candidates\":[]}")
                .put("channels", new JSONObject()
                        .put("stable", channel("stable-bundle", "stable-12"))
                        .put("preview", channel("trial-bundle", "trial-13")))
                .put("candidates", new org.json.JSONArray().put(stable).put(preview));
    }

    private static JSONObject candidate(
            String channel, String releaseId, String bundleId, long code, String version) throws Exception {
        return new JSONObject().put("channel", channel).put("release_id", releaseId)
                .put("bundle_id", bundleId).put("source_ref", "a".repeat(40))
                .put("compatibility", new JSONObject().put("eligible", true)
                        .put("reasons", new org.json.JSONArray()))
                .put("artifact", new JSONObject().put("surface", "android")
                        .put("app_id", "ag.companion").put("version_code", code)
                        .put("version_name", version).put("sha256", "b".repeat(64))
                        .put("size_bytes", 4096L).put("download_url",
                                "https://gateway.test/v1/release-recovery/artifacts/"
                                        + releaseId + ".apk"));
    }

    private static JSONObject channel(String bundleId, String releaseId) throws Exception {
        return new JSONObject().put("sequence", 0L).put("bundle",
                new JSONObject().put("bundle_id", bundleId).put("release_id", releaseId));
    }

    private static void respond(Socket socket, String body) throws Exception {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String headers = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                + "Content-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n";
        socket.getOutputStream().write(headers.getBytes(StandardCharsets.UTF_8));
        socket.getOutputStream().write(bytes);
        socket.getOutputStream().flush();
    }
}
