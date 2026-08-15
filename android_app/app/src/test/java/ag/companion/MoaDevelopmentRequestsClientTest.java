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
import static org.junit.Assert.assertFalse;

public final class MoaDevelopmentRequestsClientTest {
    private ServerSocket server;
    private Thread worker;
    private final AtomicReference<String> request = new AtomicReference<>("");

    @Before public void setUp() throws Exception {
        server = new ServerSocket(0);
        worker = new Thread(this::serve, "development-request-client-test");
        worker.start();
    }

    @After public void tearDown() throws Exception {
        server.close();
        worker.join(1000);
    }

    @Test public void createUsesDeviceIdentityAndCannotSubmitProgress() throws Exception {
        String token = "ag_dev_v1." + "a".repeat(43);
        MoaDevelopmentRequestsClient client = new MoaDevelopmentRequestsClient(
                "http://127.0.0.1:" + server.getLocalPort(), token, "phone_1");
        client.create("Better home", "Replace the developer control panel", "idem-1");

        String wire = request.get();
        assertEquals("POST /v1/development-requests HTTP/1.1", wire.split("\r\n")[0]);
        assertEquals(true, wire.contains("Authorization: Device " + token));
        assertEquals(true, wire.contains("X-Moa-Device-Id: phone_1"));
        JSONObject body = new JSONObject(wire.substring(wire.indexOf("\r\n\r\n") + 4));
        assertEquals("chief-moa", body.getString("project_id"));
        assertEquals("android", body.getJSONObject("provenance").getString("surface"));
        assertFalse(body.has("progress"));
        assertFalse(body.has("tenant_id"));
        assertFalse(body.has("user_id"));
    }

    private void serve() {
        try (Socket socket = server.accept()) {
            InputStream input = socket.getInputStream();
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            int contentLength = 0;
            int matched = 0;
            while (matched < 4) {
                int next = input.read();
                if (next < 0) return;
                output.write(next);
                byte[] end = {'\r', '\n', '\r', '\n'};
                matched = next == end[matched] ? matched + 1 : (next == '\r' ? 1 : 0);
            }
            String head = output.toString(StandardCharsets.UTF_8.name());
            for (String line : head.split("\r\n")) {
                if (line.toLowerCase().startsWith("content-length:"))
                    contentLength = Integer.parseInt(line.substring(line.indexOf(':') + 1).trim());
            }
            for (int index = 0; index < contentLength; index++) output.write(input.read());
            request.set(output.toString(StandardCharsets.UTF_8.name()));
            byte[] body = "{\"development_request\":{\"request_id\":\"devreq_1\"}}"
                    .getBytes(StandardCharsets.UTF_8);
            String headers = "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: "
                    + body.length + "\r\nConnection: close\r\n\r\n";
            socket.getOutputStream().write(headers.getBytes(StandardCharsets.UTF_8));
            socket.getOutputStream().write(body);
            socket.getOutputStream().flush();
        } catch (Exception ignored) { }
    }
}
