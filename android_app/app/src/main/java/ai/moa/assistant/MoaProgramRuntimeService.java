package ai.moa.assistant;

import android.annotation.SuppressLint;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebViewRenderProcess;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Dedicated-process JavaScript runtime. Platform capabilities remain in the client process. */
public final class MoaProgramRuntimeService extends Service {
    static final int START = 1;
    static final int RESPONSE = 2;
    static final int STOP = 3;

    static final int READY = 101;
    static final int CALL = 102;
    static final int FINISH = 103;

    private static final int MAX_PAYLOAD_BYTES = 131_072;
    private static final String KEY_SOURCE = "source";
    private static final String KEY_ALLOWED_CAPABILITY_IDS = "allowed_capability_ids";
    private static final String KEY_PAYLOAD = "payload";

    private final Handler mainHandler = new Handler(Looper.getMainLooper(), this::handleMessage);
    private final Messenger incoming = new Messenger(mainHandler);
    private Messenger client;
    private WebView webView;
    private RuntimeBridge bridge;

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 28) {
            WebView.setDataDirectorySuffix("moa_program_runtime");
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return incoming.getBinder();
    }

    @Override
    public void onDestroy() {
        destroyRuntime();
        super.onDestroy();
    }

    private boolean handleMessage(Message message) {
        switch (message.what) {
            case START:
                startRuntime(message.getData(), message.replyTo);
                return true;
            case RESPONSE:
                deliverResponse(message.getData());
                return true;
            case STOP:
                destroyRuntime();
                return true;
            default:
                return false;
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void startRuntime(Bundle data, Messenger replyTo) {
        destroyRuntime();
        if (Build.VERSION.SDK_INT < 29 || data == null || replyTo == null) {
            return;
        }

        String source = data.getString(KEY_SOURCE);
        String allowedJson = data.getString(KEY_ALLOWED_CAPABILITY_IDS);
        JSONArray allowed = parseAllowedCapabilities(allowedJson);
        if (!isBounded(source) || !isBounded(allowedJson) || allowed == null) {
            sendFinish(replyTo, failurePayload());
            return;
        }

        client = replyTo;
        bridge = new RuntimeBridge();
        webView = new WebView(getApplicationContext());
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBlockNetworkLoads(true);
        settings.setDomStorageEnabled(false);
        settings.setDatabaseEnabled(false);
        settings.setGeolocationEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSaveFormData(false);
        webView.clearCache(true);
        webView.clearHistory();
        webView.addJavascriptInterface(bridge, "AndroidBridge");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true;
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return true;
            }
        });
        bridge.startConfig = object("source", source, "allowed_capability_ids", allowed).toString();
        webView.loadDataWithBaseURL(
                "about:blank",
                readAsset("moa_program_runtime.html"),
                "text/html",
                "UTF-8",
                null);
    }

    private void deliverResponse(Bundle data) {
        if (webView == null || data == null) {
            return;
        }
        String payload = data.getString(KEY_PAYLOAD);
        if (!isBounded(payload)) {
            finishWithFailure();
            return;
        }
        try {
            JSONObject response = new JSONObject(payload);
            webView.evaluateJavascript("window.__moaResolve(" + response + ")", null);
        } catch (Exception ignored) {
            finishWithFailure();
        }
    }

    private void finishWithFailure() {
        Messenger target = client;
        if (target != null) {
            sendFinish(target, failurePayload());
        }
        destroyRuntime();
    }

    private void destroyRuntime() {
        WebView active = webView;
        webView = null;
        bridge = null;
        client = null;
        if (active == null) {
            return;
        }
        active.removeJavascriptInterface("AndroidBridge");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            WebViewRenderProcess renderer = active.getWebViewRenderProcess();
            if (renderer != null) renderer.terminate();
        }
        active.stopLoading();
        active.destroy();
    }

    private final class RuntimeBridge {
        String startConfig;

        @JavascriptInterface
        public void ready() {
            mainHandler.post(() -> {
                if (!isActive(this) || startConfig == null) {
                    return;
                }
                send(client, READY, null);
                webView.evaluateJavascript("window.__moaStart(" + startConfig + ")", null);
            });
        }

        @JavascriptInterface
        public void call(String payload) {
            mainHandler.post(() -> {
                if (!isActive(this)) {
                    return;
                }
                if (!isBounded(payload)) {
                    finishWithFailure();
                    return;
                }
                send(client, CALL, payload);
            });
        }

        @JavascriptInterface
        public void finish(String payload) {
            mainHandler.post(() -> {
                if (!isActive(this)) {
                    return;
                }
                String closed = closeTerminalPayload(payload);
                sendFinish(client, closed);
                destroyRuntime();
            });
        }
    }

    private boolean isActive(RuntimeBridge candidate) { return bridge == candidate && webView != null && client != null; }

    private static JSONArray parseAllowedCapabilities(String encoded) {
        if (!isBounded(encoded)) {
            return null;
        }
        try {
            JSONArray input = new JSONArray(encoded);
            JSONArray result = new JSONArray();
            for (int i = 0; i < input.length(); i++) {
                Object value = input.get(i);
                if (!(value instanceof String)) {
                    return null;
                }
                result.put(value);
            }
            return result;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String closeTerminalPayload(String payload) {
        if (!isBounded(payload)) {
            return failurePayload();
        }
        try {
            JSONObject input = new JSONObject(payload);
            Object okValue = input.opt("ok");
            if (!"terminal".equals(input.optString("type")) || !(okValue instanceof Boolean)) {
                return failurePayload();
            }
            boolean ok = (Boolean) okValue;
            if (!ok) {
                return failurePayload();
            }
            Object result = input.has("result") ? input.get("result") : JSONObject.NULL;
            String closed = object("type", "terminal", "ok", true, "result", result).toString();
            return isBounded(closed) ? closed : failurePayload();
        } catch (Exception ignored) {
            return failurePayload();
        }
    }

    private static String failurePayload() {
        return object("type", "terminal", "ok", false, "code", "runtime_failed").toString();
    }

    private static void sendFinish(Messenger target, String payload) {
        send(target, FINISH, payload);
    }

    private static void send(Messenger target, int what, String payload) {
        Message message = Message.obtain(null, what);
        if (payload != null) {
            Bundle data = new Bundle();
            data.putString(KEY_PAYLOAD, payload);
            message.setData(data);
        }
        try {
            target.send(message);
        } catch (RemoteException ignored) {
            // The client owns reconnection and execution-state recovery.
        }
    }

    private static boolean isBounded(String value) {
        return value != null && value.getBytes(StandardCharsets.UTF_8).length <= MAX_PAYLOAD_BYTES;
    }

    private String readAsset(String name) {
        try (InputStream input = getAssets().open(name);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        } catch (Exception error) {
            throw new IllegalStateException("Missing local runtime asset", error);
        }
    }

    private static JSONObject object(Object... pairs) {
        JSONObject result = new JSONObject();
        try {
            for (int i = 0; i < pairs.length; i += 2) {
                result.put(String.valueOf(pairs[i]), pairs[i + 1]);
            }
            return result;
        } catch (Exception error) {
            throw new IllegalStateException("Unable to encode runtime message", error);
        }
    }
}
