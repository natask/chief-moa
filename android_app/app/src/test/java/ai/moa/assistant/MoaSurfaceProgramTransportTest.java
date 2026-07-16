package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.fail;

public final class MoaSurfaceProgramTransportTest {
    @Test public void routesEveryClosedDeliveryKind() throws Exception {
        RecordingPoster poster = new RecordingPoster();
        MoaSurfaceProgramTransport transport = new MoaSurfaceProgramTransport(poster);
        JSONObject event = new JSONObject().put("kind", "accepted");
        JSONObject tool = new JSONObject().put("type", "surface.execution.tool_receipt");
        JSONObject terminal = new JSONObject().put("type", "surface.execution.receipt");

        assertSame(poster.response, transport.deliver("req_01HX-abc", MoaSurfaceProgramTransport.EVENT, event));
        assertSame(poster.response, transport.deliver("req_01HX-abc", MoaSurfaceProgramTransport.TOOL_RECEIPT, tool));
        assertSame(poster.response, transport.deliver("req_01HX-abc", MoaSurfaceProgramTransport.TERMINAL_RECEIPT, terminal));

        assertEquals(List.of(
                "/v1/tool/requests/req_01HX-abc/events",
                "/v1/tool/requests/req_01HX-abc/tool-receipts",
                "/v1/tool/requests/req_01HX-abc/receipts"), poster.paths);
        assertEquals(List.of(event, tool, terminal), poster.bodies);
        assertEquals(List.of(15_000, 15_000, 15_000), poster.timeouts);
    }

    @Test public void requestIdMustBeNonemptyAndPathSafe() throws Exception {
        MoaSurfaceProgramTransport transport = new MoaSurfaceProgramTransport(new RecordingPoster());
        for (String id : new String[]{"", " ", "request/child", "request.child", "request?query", "réquest"}) {
            expectArgument(() -> transport.deliver(id, MoaSurfaceProgramTransport.EVENT, new JSONObject()));
        }
        expectArgument(() -> transport.deliver(null, MoaSurfaceProgramTransport.EVENT, new JSONObject()));
    }

    @Test public void payloadAndKindAreClosed() throws Exception {
        MoaSurfaceProgramTransport transport = new MoaSurfaceProgramTransport(new RecordingPoster());
        expectArgument(() -> transport.deliver("request_1", MoaSurfaceProgramTransport.EVENT, null));
        expectArgument(() -> transport.deliver("request_1", "events", new JSONObject()));
        expectArgument(() -> transport.deliver("request_1", "", new JSONObject()));
        expectArgument(() -> transport.deliver("request_1", null, new JSONObject()));
    }

    @Test public void constructionRequiresTransportAuthority() throws Exception {
        expectArgument(() -> new MoaSurfaceProgramTransport(null));
        expectArgument(() -> MoaSurfaceProgramTransport.gateway(null));
        MoaSurfaceProgramTransport.gateway(new MoaGatewayClient("https://gateway.invalid", "token"));
    }

    @Test public void transportFailurePropagatesWithoutAcknowledgementSignal() throws Exception {
        IOException failure = new IOException("offline");
        MoaSurfaceProgramTransport transport = new MoaSurfaceProgramTransport((path, body, timeout) -> {
            throw failure;
        });
        try {
            transport.deliver("request_1", MoaSurfaceProgramTransport.EVENT, new JSONObject());
            fail("expected transport failure");
        } catch (IOException actual) {
            assertSame(failure, actual);
        }
    }

    private static void expectArgument(ThrowingAction action) throws Exception {
        try {
            action.run();
            fail("expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            // Closed validation failure.
        }
    }

    private interface ThrowingAction { void run() throws Exception; }

    private static final class RecordingPoster implements MoaSurfaceProgramTransport.JsonPoster {
        final JSONObject response = new JSONObject();
        final List<String> paths = new ArrayList<>();
        final List<JSONObject> bodies = new ArrayList<>();
        final List<Integer> timeouts = new ArrayList<>();

        @Override public JSONObject post(String path, JSONObject body, int timeoutMs) {
            paths.add(path);
            bodies.add(body);
            timeouts.add(timeoutMs);
            return response;
        }
    }
}
