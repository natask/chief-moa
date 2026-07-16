package ai.moa.assistant;

import org.json.JSONObject;

import java.util.regex.Pattern;

/** Sends the closed surface-program event and receipt protocol to the gateway. */
final class MoaSurfaceProgramTransport {
    static final String EVENT = "event";
    static final String TOOL_RECEIPT = "tool_receipt";
    static final String TERMINAL_RECEIPT = "terminal_receipt";

    private static final int TIMEOUT_MS = 15_000;
    private static final Pattern REQUEST_ID = Pattern.compile("[A-Za-z0-9_-]+");

    interface JsonPoster {
        JSONObject post(String path, JSONObject body, int timeoutMs) throws Exception;
    }

    private final JsonPoster poster;

    MoaSurfaceProgramTransport(JsonPoster poster) {
        if (poster == null) throw new IllegalArgumentException("poster is required");
        this.poster = poster;
    }

    static MoaSurfaceProgramTransport gateway(MoaGatewayClient client) {
        if (client == null) throw new IllegalArgumentException("gateway client is required");
        return new MoaSurfaceProgramTransport(client::postApiJson);
    }

    JSONObject deliver(String requestId, String kind, JSONObject payload) throws Exception {
        String id = requireRequestId(requestId);
        if (payload == null) throw new IllegalArgumentException("surface program payload is required");

        final String suffix;
        if (EVENT.equals(kind)) suffix = "events";
        else if (TOOL_RECEIPT.equals(kind)) suffix = "tool-receipts";
        else if (TERMINAL_RECEIPT.equals(kind)) suffix = "receipts";
        else throw new IllegalArgumentException("unsupported surface program delivery kind");

        return poster.post("/v1/tool/requests/" + id + "/" + suffix, payload, TIMEOUT_MS);
    }

    private static String requireRequestId(String requestId) {
        if (requestId == null || !REQUEST_ID.matcher(requestId).matches()) {
            throw new IllegalArgumentException("valid tool request id is required");
        }
        return requestId;
    }
}
