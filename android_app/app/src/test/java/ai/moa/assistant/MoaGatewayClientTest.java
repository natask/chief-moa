package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.io.InputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public final class MoaGatewayClientTest {
    private TestHttpServer server;
    private String baseUrl;
    private List<RequestRecord> requests;

    @Before
    public void setUp() throws Exception {
        requests = new ArrayList<>();
        server = new TestHttpServer(this::responseFor);
        server.start();
        baseUrl = "http://127.0.0.1:" + server.port();
    }

    @After
    public void tearDown() throws Exception {
        if (server != null) {
            server.close();
        }
    }

    @Test
    public void chatSendsTokenAndParsesConversationId() throws Exception {
        MoaGatewayClient client = new MoaGatewayClient(baseUrl, "secret-token");

        MoaGatewayClient.GatewayTextResponse response = client.chat(new JSONObject()
                .put("messages", List.of(new JSONObject()
                        .put("role", "user")
                        .put("content", "hello"))));

        assertEquals("hello back", response.text);
        assertEquals("conversation-1", response.conversationId);
        assertEquals("POST", requests.get(0).method);
        assertEquals("/v1/chat", requests.get(0).path);
        assertEquals("Bearer secret-token", requests.get(0).authorization);
        assertTrue(requests.get(0).body.contains("hello"));
    }

    @Test
    public void baseUrlMayPointAtLegacyChatEndpoint() throws Exception {
        MoaGatewayClient client = new MoaGatewayClient(baseUrl + "/v1/chat", "secret-token");

        JSONObject response = client.voiceTurn(new JSONObject()
                .put("session_id", "session-1")
                .put("turn_id", "turn-1")
                .put("transcript", "stop"));

        assertEquals("control", response.getString("classification"));
        assertEquals("/v1/voice/turns", requests.get(0).path);
    }

    @Test
    public void agentRunUsesGatewayTextWhenPresent() throws Exception {
        MoaGatewayClient client = new MoaGatewayClient(baseUrl, "");

        JSONObject response = client.agentRun(new JSONObject()
                .put("prompt", "run it")
                .put("wait", false));

        assertEquals("Started run run_123.", MoaGatewayClient.agentRunReply(response));
        assertEquals("/v1/agent/runs", requests.get(0).path);
    }

    @Test
    public void agentRunFallsBackToRunStatusSummary() throws Exception {
        MoaGatewayClient client = new MoaGatewayClient(baseUrl + "/", "");

        JSONObject response = client.agentRun(new JSONObject()
                .put("prompt", "run without text")
                .put("wait", false)
                .put("mode", "no_text"));

        assertEquals("Home-machine agent run run_456 is queued.", MoaGatewayClient.agentRunReply(response));
    }

    @Test
    public void agentRunsClampsLimitAndParsesList() throws Exception {
        MoaGatewayClient client = new MoaGatewayClient(baseUrl, "secret-token");

        JSONObject response = client.agentRuns(500);

        assertEquals("run_789", response.getJSONArray("runs").getJSONObject(0).getString("id"));
        assertEquals("/v1/agent/runs", requests.get(0).path);
        assertEquals("/v1/agent/runs?limit=100", requests.get(0).target);
        assertEquals("Bearer secret-token", requests.get(0).authorization);
    }

    @Test
    public void agentRunDetailSanitizesRunId() throws Exception {
        MoaGatewayClient client = new MoaGatewayClient(baseUrl, "");

        JSONObject response = client.agentRunDetail("run_abc/../bad");

        assertEquals("run_abcbad", response.getJSONObject("run").getString("id"));
        assertEquals("/v1/agent/runs/run_abcbad", requests.get(0).path);
    }

    @Test
    public void cancelAgentRunPostsToSanitizedRunEndpoint() throws Exception {
        MoaGatewayClient client = new MoaGatewayClient(baseUrl, "secret-token");
        JSONObject response = client.cancelAgentRun("run_stop/../bad");
        assertEquals("canceled", response.getJSONObject("run").getString("status"));
        assertEquals("POST", requests.get(0).method);
        assertEquals("/v1/agent/runs/run_stopbad/cancel", requests.get(0).path);
        assertEquals("Bearer secret-token", requests.get(0).authorization);
    }

    @Test
    public void agentRunFollowUpPostsToParentRun() throws Exception {
        MoaGatewayClient client = new MoaGatewayClient(baseUrl, "secret-token");

        JSONObject response = client.agentRunFollowUp("run_parent", new JSONObject()
                .put("prompt", "continue"));

        assertEquals("run_parent", response.getString("parent_run_id"));
        assertEquals("run_child", response.getJSONObject("run").getString("id"));
        assertEquals("/v1/agent/runs/run_parent/followups", requests.get(0).path);
        assertTrue(requests.get(0).body.contains("continue"));
    }

    @Test
    public void latestAndroidUpdateParsesManifest() throws Exception {
        MoaGatewayClient client = new MoaGatewayClient(baseUrl, "secret-token");

        JSONObject manifest = client.latestAndroidUpdate();

        assertEquals(42, manifest.getInt("version_code"));
        assertEquals("0.1.42", manifest.getString("version_name"));
        assertEquals("/v1/android/updates/latest", requests.get(0).path);
        assertEquals("Bearer secret-token", requests.get(0).authorization);
    }

    @Test
    public void latestContextParsesGatewayContext() throws Exception {
        MoaGatewayClient client = new MoaGatewayClient(baseUrl, "secret-token");

        JSONObject context = client.latestContext();

        assertEquals("json-files", context.getJSONObject("store").getString("type"));
        assertEquals(1, context.getJSONArray("recent_runs").length());
        assertEquals("/v1/context/latest", requests.get(0).path);
        assertEquals("Bearer secret-token", requests.get(0).authorization);
    }

    @Test
    public void agentProfileFetchesDeviceScopedProfile() throws Exception {
        MoaGatewayClient client = new MoaGatewayClient(baseUrl, "secret-token");

        JSONObject payload = client.agentProfile("device", "android_abc");

        assertEquals("am-ET", payload.getJSONObject("profile").getString("input_language_primary"));
        assertEquals("/v1/agent/profile", requests.get(0).path);
        assertEquals("/v1/agent/profile?scope=device&device_id=android_abc", requests.get(0).target);
        assertEquals("Bearer secret-token", requests.get(0).authorization);
    }

    @Test
    public void httpErrorsIncludeStatus() throws Exception {
        MoaGatewayClient client = new MoaGatewayClient(baseUrl, "");

        try {
            client.voiceTurn(new JSONObject().put("mode", "error"));
        } catch (IllegalStateException error) {
            assertTrue(error.getMessage().contains("HTTP 401"));
            return;
        }

        throw new AssertionError("Expected gateway error");
    }

    private TestResponse responseFor(RequestRecord request) {
        requests.add(request);
        if (request.body.contains("\"mode\":\"error\"")) {
            return new TestResponse(401, "{\"error\":\"missing token\"}");
        }

        if ("/v1/chat".equals(request.path)) {
            return new TestResponse(200, "{\"conversation_id\":\"conversation-1\",\"text\":\"hello back\"}");
        } else if ("/v1/voice/turns".equals(request.path)) {
            return new TestResponse(200, "{\"classification\":\"control\",\"text\":\"\",\"actions\":[{\"type\":\"control\",\"name\":\"stop\"}]}");
        } else if ("/v1/agent/runs".equals(request.path) && "GET".equals(request.method)) {
            return new TestResponse(200, "{\"runs\":[{\"id\":\"run_789\",\"status\":\"running\"}]}");
        } else if ("/v1/agent/runs/run_abcbad".equals(request.path)) {
            return new TestResponse(200, "{\"run\":{\"id\":\"run_abcbad\",\"status\":\"completed\"},\"events\":[]}");
        } else if ("/v1/agent/runs/run_stopbad/cancel".equals(request.path)) {
            return new TestResponse(202, "{\"run\":{\"id\":\"run_stopbad\",\"status\":\"canceled\"}}");
        } else if ("/v1/agent/runs/run_parent/followups".equals(request.path)) {
            return new TestResponse(202, "{\"parent_run_id\":\"run_parent\",\"run\":{\"id\":\"run_child\",\"status\":\"queued\"}}");
        } else if ("/v1/agent/runs".equals(request.path) && request.body.contains("\"no_text\"")) {
            return new TestResponse(202, "{\"run\":{\"id\":\"run_456\",\"status\":\"queued\"}}");
        } else if ("/v1/agent/runs".equals(request.path)) {
            return new TestResponse(202, "{\"run\":{\"id\":\"run_123\",\"status\":\"queued\"},\"text\":\"Started run run_123.\"}");
        } else if ("/v1/android/updates/latest".equals(request.path)) {
            return new TestResponse(200, "{\"version_code\":42,\"version_name\":\"0.1.42\"}");
        } else if ("/v1/context/latest".equals(request.path)) {
            return new TestResponse(200, "{\"store\":{\"type\":\"json-files\"},\"recent_runs\":[{\"id\":\"run_789\"}],\"recent_turns\":[],\"sessions\":[]}");
        } else if ("/v1/agent/profile".equals(request.path)) {
            return new TestResponse(200, "{\"profile\":{\"language\":\"am-ET\",\"language_primary\":\"am-ET\",\"input_languages\":\"am-ET,en-US\",\"input_language_primary\":\"am-ET\"}}");
        }
        return new TestResponse(404, "{\"error\":\"not found\"}");
    }

    private static final class RequestRecord {
        final String method;
        final String target;
        final String path;
        final String authorization;
        final String body;

        RequestRecord(String method, String target, String path, String authorization, String body) {
            this.method = method;
            this.target = target;
            this.path = path;
            this.authorization = authorization;
            this.body = body;
        }
    }

    private interface ResponseFactory {
        TestResponse responseFor(RequestRecord request);
    }

    private static final class TestResponse {
        final int status;
        final String body;

        TestResponse(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    private static final class TestHttpServer implements AutoCloseable {
        private final ServerSocket serverSocket;
        private final ResponseFactory responseFactory;
        private final CountDownLatch stopped = new CountDownLatch(1);
        private volatile boolean closed;
        private Thread thread;

        TestHttpServer(ResponseFactory responseFactory) throws IOException {
            this.responseFactory = responseFactory;
            this.serverSocket = new ServerSocket(0);
        }

        void start() {
            thread = new Thread(this::acceptLoop, "moa-gateway-client-test-server");
            thread.start();
        }

        int port() {
            return serverSocket.getLocalPort();
        }

        @Override
        public void close() throws Exception {
            closed = true;
            serverSocket.close();
            stopped.await(2, TimeUnit.SECONDS);
        }

        private void acceptLoop() {
            try {
                while (!closed) {
                    try (Socket socket = serverSocket.accept()) {
                        handle(socket);
                    }
                }
            } catch (IOException error) {
                if (!closed) {
                    throw new RuntimeException(error);
                }
            } finally {
                stopped.countDown();
            }
        }

        private void handle(Socket socket) throws IOException {
            InputStream input = socket.getInputStream();
            StringBuilder header = new StringBuilder();
            int previous = -1;
            int current;
            while ((current = input.read()) != -1) {
                header.append((char) current);
                if (previous == '\r' && current == '\n' && header.toString().endsWith("\r\n\r\n")) {
                    break;
                }
                previous = current;
            }

            String headerText = header.toString();
            String[] lines = headerText.split("\r\n");
            String[] requestLine = lines[0].split(" ");
            String method = requestLine[0];
            String target = requestLine[1];
            String path = target.split("\\?", 2)[0];
            String authorization = "";
            int contentLength = 0;
            for (String line : lines) {
                int separator = line.indexOf(':');
                if (separator <= 0) {
                    continue;
                }
                String name = line.substring(0, separator).trim();
                String value = line.substring(separator + 1).trim();
                if ("authorization".equalsIgnoreCase(name)) {
                    authorization = value;
                } else if ("content-length".equalsIgnoreCase(name)) {
                    contentLength = Integer.parseInt(value);
                }
            }

            byte[] bodyBytes = input.readNBytes(contentLength);
            RequestRecord request = new RequestRecord(method, target, path, authorization, new String(bodyBytes, StandardCharsets.UTF_8));
            TestResponse response = responseFactory.responseFor(request);
            byte[] responseBytes = response.body.getBytes(StandardCharsets.UTF_8);
            String responseHeader = "HTTP/1.1 " + response.status + " " + reasonFor(response.status) + "\r\n"
                    + "Content-Type: application/json; charset=utf-8\r\n"
                    + "Content-Length: " + responseBytes.length + "\r\n"
                    + "Connection: close\r\n\r\n";
            socket.getOutputStream().write(responseHeader.getBytes(StandardCharsets.UTF_8));
            socket.getOutputStream().write(responseBytes);
            socket.getOutputStream().flush();
        }

        private static String reasonFor(int status) {
            if (status == 200) {
                return "OK";
            }
            if (status == 202) {
                return "Accepted";
            }
            if (status == 401) {
                return "Unauthorized";
            }
            if (status == 404) {
                return "Not Found";
            }
            return "Status";
        }
    }
}
