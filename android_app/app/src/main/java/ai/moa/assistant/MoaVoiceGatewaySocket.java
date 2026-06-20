package ai.moa.assistant;

import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

final class MoaVoiceGatewaySocket {
    private static final String TAG = "MoaVoiceSocket";
    static final String DEFAULT_URL = "ws://10.147.17.10:8788/v1/voice/sessions";
    private static final int CONNECT_TIMEOUT_MS = 3500;
    private static final int WRITE_TIMEOUT_MS = 10000;

    interface Callback {
        void onSocketOpen();

        void onSocketClosed(int code, String reason);

        void onSocketFailure(String message, Throwable error);

        void onJsonEvent(JSONObject event);

        void onSessionReady(String sessionId);

        void onTranscriptPartial(String turnId, String text);

        void onTranscriptFinal(String turnId, String text);

        void onAssistantText(String turnId, String text);

        void onAssistantAudioStart(String turnId, JSONObject format);

        void onAssistantAudio(byte[] pcm);

        void onAssistantAudioDone(String turnId);

        void onTurnDone(String turnId, String status, boolean transcriptionOnly);

        void onGatewayError(String message);
    }

    private final String url;
    private final String token;
    private final Callback callback;
    private final OkHttpClient client;
    private final Object lock = new Object();

    private WebSocket webSocket;
    private boolean assistantAudioOpen;
    private boolean destroyed;

    MoaVoiceGatewaySocket(Callback callback) {
        this(DEFAULT_URL, "", callback);
    }

    MoaVoiceGatewaySocket(String url, String token, Callback callback) {
        this.url = voiceSocketUrl(url);
        this.token = safe(token);
        this.callback = callback;
        this.client = new OkHttpClient.Builder()
                .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .writeTimeout(WRITE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build();
    }

    void connect() {
        synchronized (lock) {
            if (webSocket != null || destroyed) {
                return;
            }
            Request.Builder builder = new Request.Builder().url(url);
            if (!token.isEmpty()) {
                builder.header("Authorization", "Bearer " + token);
            }
            Log.i(TAG, "connect -> " + redactedUrl(url) + " token=" + (token.isEmpty() ? "MISSING" : "set(" + token.length() + ")"));
            webSocket = client.newWebSocket(builder.build(), new Listener());
        }
    }

    boolean sendJson(JSONObject body) {
        if (body == null) {
            return false;
        }
        WebSocket socket = currentSocket();
        return socket != null && socket.send(body.toString());
    }

    boolean sendAudio(byte[] pcm) {
        if (pcm == null || pcm.length == 0) {
            return false;
        }
        WebSocket socket = currentSocket();
        return socket != null && socket.send(ByteString.of(pcm, 0, pcm.length));
    }

    boolean sendSessionStart(String sessionId, String turnId) {
        return sendSessionStart(sessionId, turnId, "default");
    }

    boolean sendSessionStart(String sessionId, String turnId, String branchId) {
        try {
            JSONObject format = new JSONObject();
            format.put("encoding", MoaAudioCaptureController.ENCODING);
            format.put("sample_rate", MoaAudioCaptureController.SAMPLE_RATE_HZ);
            format.put("channels", MoaAudioCaptureController.CHANNEL_COUNT);

            JSONObject body = new JSONObject();
            body.put("type", "session_start");
            body.put("session_id", sessionId);
            body.put("conversation_id", sessionId);
            body.put("branch_id", safe(branchId).isEmpty() ? "default" : safe(branchId));
            body.put("turn_id", turnId);
            body.put("format", format);
            body.put("source", "android-overlay");
            return sendJson(body);
        } catch (JSONException error) {
            reportFailure("Could not build session_start event.", error);
            return false;
        }
    }

    boolean sendCommitTurn(String turnId) {
        return sendTurnEvent("commit_turn", turnId);
    }

    boolean sendCancelTurn(String turnId) {
        return sendTurnEvent("cancel_turn", turnId);
    }

    void close() {
        WebSocket socket;
        synchronized (lock) {
            socket = webSocket;
            webSocket = null;
            assistantAudioOpen = false;
        }
        if (socket != null) {
            socket.close(1000, "android client closed");
        }
    }

    void destroy() {
        WebSocket socket;
        synchronized (lock) {
            destroyed = true;
            socket = webSocket;
            webSocket = null;
            assistantAudioOpen = false;
        }
        if (socket != null) {
            socket.cancel();
        }
        client.dispatcher().executorService().shutdown();
    }

    private boolean sendTurnEvent(String type, String turnId) {
        try {
            JSONObject body = new JSONObject();
            body.put("type", type);
            body.put("turn_id", turnId);
            return sendJson(body);
        } catch (JSONException error) {
            reportFailure("Could not build " + type + " event.", error);
            return false;
        }
    }

    private WebSocket currentSocket() {
        synchronized (lock) {
            return webSocket;
        }
    }

    private void dispatchText(String text) {
        JSONObject event;
        try {
            event = new JSONObject(text);
        } catch (JSONException error) {
            reportFailure("Gateway sent invalid JSON: " + cleanError(error) + ".", error);
            return;
        }

        if (callback != null) {
            callback.onJsonEvent(event);
        }

        String type = event.optString("type", "").trim();
        switch (type) {
            case "session_ready":
                Log.i(TAG, "session_ready session_id=" + event.optString("session_id", ""));
                if (callback != null) {
                    callback.onSessionReady(event.optString("session_id", ""));
                }
                break;
            case "transcript_partial":
                if (callback != null) {
                    callback.onTranscriptPartial(event.optString("turn_id", ""), event.optString("text", ""));
                }
                break;
            case "transcript_final":
                if (callback != null) {
                    callback.onTranscriptFinal(event.optString("turn_id", ""), event.optString("text", ""));
                }
                break;
            case "assistant_text":
                if (callback != null) {
                    callback.onAssistantText(event.optString("turn_id", ""), event.optString("text", ""));
                }
                break;
            case "assistant_audio_start":
                synchronized (lock) {
                    assistantAudioOpen = true;
                }
                if (callback != null) {
                    callback.onAssistantAudioStart(event.optString("turn_id", ""), event.optJSONObject("format"));
                }
                break;
            case "assistant_audio_done":
                synchronized (lock) {
                    assistantAudioOpen = false;
                }
                if (callback != null) {
                    callback.onAssistantAudioDone(event.optString("turn_id", ""));
                }
                break;
            case "turn_done":
                if (callback != null) {
                    callback.onTurnDone(
                            event.optString("turn_id", ""),
                            event.optString("status", ""),
                            event.optBoolean("transcription_only", false)
                    );
                }
                break;
            case "error":
                Log.e(TAG, "gateway error event: " + event.optString("message", "gateway error"));
                if (callback != null) {
                    callback.onGatewayError(event.optString("message", "gateway error"));
                }
                break;
            default:
                break;
        }
    }

    private void dispatchBinary(ByteString bytes) {
        boolean shouldPlay;
        synchronized (lock) {
            shouldPlay = assistantAudioOpen;
        }
        if (!shouldPlay) {
            reportFailure("Gateway sent audio before assistant_audio_start.", null);
            return;
        }
        if (callback != null) {
            callback.onAssistantAudio(bytes.toByteArray());
        }
    }

    private void reportFailure(String message, Throwable error) {
        if (callback != null) {
            callback.onSocketFailure(message, error);
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    private static String voiceSocketUrl(String value) {
        String url = safe(value);
        if (url.isEmpty()) {
            return DEFAULT_URL;
        }
        if (url.startsWith("http://")) {
            url = "ws://" + url.substring("http://".length());
        } else if (url.startsWith("https://")) {
            url = "wss://" + url.substring("https://".length());
        }
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        if (url.endsWith("/v1/voice/sessions")) {
            return url;
        }
        if (url.endsWith("/v1/chat")) {
            url = url.substring(0, url.length() - "/v1/chat".length());
        }
        return url + "/v1/voice/sessions";
    }

    private static String cleanError(Throwable error) {
        if (error == null) {
            return "unknown error";
        }
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) {
            return error.getClass().getSimpleName();
        }
        return message.replace('\n', ' ').replace('\r', ' ').trim();
    }

    private static String socketFailureMessage(String url, Throwable error, Response response) {
        String target = redactedUrl(url);
        if (response != null) {
            int status = response.code();
            if (status == 401 || status == 403) {
                return "Voice gateway rejected the socket request (HTTP " + status + "). Save the gateway token in Voice agent setup.";
            }
            if (status == 404) {
                return "Voice gateway did not expose /v1/voice/sessions at " + target + ". Check the gateway URL.";
            }
            return "Voice gateway socket failed at " + target + " (HTTP " + status + ").";
        }
        if (isTimeout(error)) {
            return "Could not reach voice gateway at " + target + " within " + CONNECT_TIMEOUT_MS + "ms. Check that the phone is on ZeroTier/VPN or the same network and that the gateway is running.";
        }
        if (error instanceof UnknownHostException) {
            return "Could not resolve voice gateway host for " + target + ". Check the gateway URL.";
        }
        if (error instanceof ConnectException) {
            return "Could not connect to voice gateway at " + target + ". Check that the gateway is running and reachable from this phone.";
        }
        return "Voice gateway socket failed at " + target + ": " + cleanError(error) + ".";
    }

    private static boolean isTimeout(Throwable error) {
        if (error == null) {
            return false;
        }
        if (error instanceof SocketTimeoutException) {
            return true;
        }
        String message = error.getMessage();
        return message != null && message.toLowerCase(java.util.Locale.US).contains("timeout");
    }

    private static String redactedUrl(String value) {
        String fallback = safe(value);
        try {
            URI uri = new URI(fallback);
            StringBuilder builder = new StringBuilder();
            builder.append(uri.getScheme()).append("://").append(uri.getHost());
            if (uri.getPort() >= 0) {
                builder.append(":").append(uri.getPort());
            }
            String path = uri.getPath();
            if (path != null && !path.isEmpty()) {
                builder.append(path);
            }
            return builder.toString();
        } catch (Exception error) {
            return fallback;
        }
    }

    private final class Listener extends WebSocketListener {
        @Override
        public void onOpen(WebSocket socket, Response response) {
            Log.i(TAG, "onOpen HTTP " + (response != null ? response.code() : -1) + " (socket upgraded)");
            if (callback != null) {
                callback.onSocketOpen();
            }
        }

        @Override
        public void onMessage(WebSocket socket, String text) {
            dispatchText(text);
        }

        @Override
        public void onMessage(WebSocket socket, ByteString bytes) {
            dispatchBinary(bytes);
        }

        @Override
        public void onClosed(WebSocket socket, int code, String reason) {
            Log.i(TAG, "onClosed code=" + code + " reason=" + reason);
            synchronized (lock) {
                if (webSocket == socket) {
                    webSocket = null;
                }
                assistantAudioOpen = false;
            }
            if (callback != null) {
                callback.onSocketClosed(code, reason);
            }
        }

        @Override
        public void onFailure(WebSocket socket, Throwable error, Response response) {
            synchronized (lock) {
                if (webSocket == socket) {
                    webSocket = null;
                }
                assistantAudioOpen = false;
            }
            Log.e(TAG, "onFailure HTTP " + (response != null ? response.code() : -1)
                    + " err=" + (error != null ? error.getClass().getSimpleName() + ":" + cleanError(error) : "none")
                    + " msg=" + socketFailureMessage(url, error, response), error);
            reportFailure(socketFailureMessage(url, error, response), error);
        }
    }
}
