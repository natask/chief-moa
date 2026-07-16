package ai.moa.assistant;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/** A fresh, non-visible, offline WebView+WebWorker realm for one Android program. */
final class MoaWebViewProgramRuntime {
    interface Callback { void finished(JSONObject terminalReceipt, JSONArray toolReceipts); }

    private final Context context;
    private final Handler mainHandler;
    private final MoaAndroidProgramHost host;
    private final MoaSurfaceProgramStore store;
    private WebView webView;
    private Execution execution;

    MoaWebViewProgramRuntime(Context context, MoaAndroidProgramHost host, MoaSurfaceProgramStore store) {
        this.context = context.getApplicationContext();
        this.host = host;
        this.store = store;
        this.mainHandler = new Handler(Looper.getMainLooper());
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    void execute(MoaSurfaceProgramContract.Proposal proposal, String clientInstanceId, Callback callback) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(() -> execute(proposal, clientInstanceId, callback));
            return;
        }
        stop("replaced");
        Execution target = new Execution(proposal, clientInstanceId, callback);
        execution = target;
        webView = new WebView(context);
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
        webView.addJavascriptInterface(new Bridge(target), "AndroidBridge");
        webView.setWebViewClient(new WebViewClient());
        webView.loadDataWithBaseURL("about:blank", asset("moa_program_runtime.html"), "text/html", "UTF-8", null);
        mainHandler.postDelayed(() -> timeout(target), proposal.limits.wallMs);
    }

    void stop(String reason) {
        Execution active = execution;
        if (active != null && !active.terminal) active.finish(false, "stopped", "stopped", reason, null);
        destroyWebView();
    }

    private void timeout(Execution target) {
        if (target == null || execution != target || target.terminal) return;
        target.finish(false, "timed_out", "timed_out", "Program exceeded its wall-clock limit.", null);
        destroyWebView();
    }

    private void destroyWebView() {
        if (webView != null) {
            webView.evaluateJavascript("window.__moaStop && window.__moaStop()", null);
            webView.removeJavascriptInterface("AndroidBridge");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        execution = null;
    }

    private String asset(String name) {
        try (InputStream input = context.getAssets().open(name); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toString(StandardCharsets.UTF_8.name());
        } catch (Exception error) { throw new IllegalStateException("Missing local runtime asset", error); }
    }

    private final class Bridge {
        private final Execution target;
        Bridge(Execution target) { this.target = target; }

        @JavascriptInterface public void ready() {
            mainHandler.post(() -> {
                if (execution != target || target.terminal || webView == null) return;
                JSONObject config = object("source", target.proposal.source,
                        "allowed_capability_ids", new JSONArray(target.proposal.allowedCapabilityIds));
                webView.evaluateJavascript("window.__moaStart(" + config + ")", null);
            });
        }

        @JavascriptInterface public void call(String payload) {
            mainHandler.post(() -> target.call(payload));
        }

        @JavascriptInterface public void finish(String payload) {
            mainHandler.post(() -> {
                if (execution != target || target.terminal) return;
                try {
                    JSONObject message = new JSONObject(payload);
                    boolean ok = message.optBoolean("ok", false);
                    Object result = message.opt("result");
                    target.finish(ok, ok ? "completed" : "failed", message.optString("code", ok ? "" : "program_failed"),
                            ok ? "Android local program completed." : message.optString("error", "Program failed."), result);
                } catch (Exception error) {
                    target.finish(false, "failed", "invalid_worker_result", "Worker returned an invalid result.", null);
                }
                destroyWebView();
            });
        }
    }

    private final class Execution {
        final MoaSurfaceProgramContract.Proposal proposal;
        final String clientInstanceId;
        final Callback callback;
        final JSONArray receipts = new JSONArray();
        final Set<String> callIds = new HashSet<>();
        final long startedAtMs = System.currentTimeMillis();
        int calls, activeCalls;
        boolean terminal;
        String previousReceiptDigest = "";

        Execution(MoaSurfaceProgramContract.Proposal proposal, String clientInstanceId, Callback callback) {
            this.proposal = proposal; this.clientInstanceId = clientInstanceId; this.callback = callback;
        }

        void call(String payload) {
            if (terminal || execution != this || webView == null) return;
            long started = System.currentTimeMillis();
            JSONObject message;
            try { message = new JSONObject(payload); } catch (Exception error) { finish(false, "failed", "invalid_tool_call", "Worker emitted invalid tool JSON.", null); return; }
            String callId = message.optString("call_id", "");
            String capabilityId = message.optString("capability_id", "");
            JSONObject input = message.optJSONObject("input");
            if (input == null) input = new JSONObject();
            if (callId.isEmpty() || !callIds.add(callId) || ++calls > proposal.limits.toolCalls || ++activeCalls > proposal.limits.parallelCalls) {
                activeCalls = Math.max(0, activeCalls - 1);
                respond(callId, false, null, "budget_exceeded", "rejected", "Local tool budget exceeded.");
                return;
            }
            MoaAndroidProgramHost.HostResult result = host.call(proposal, capabilityId, input);
            activeCalls--;
            String dataDigest = result.data == null ? "" : MoaProgramJson.sha256(MoaProgramJson.canonical(result.data));
            JSONObject receipt = MoaSurfaceProgramReceipts.tool(proposal, clientInstanceId, callId, 1, capabilityId, input,
                    result.status, result.summary, dataDigest, previousReceiptDigest, started, System.currentTimeMillis());
            previousReceiptDigest = receipt.optString("receipt_sha256", "");
            receipts.put(receipt);
            if (!store.recordToolReceipt(proposal, receipt)) {
                finish(false, "indeterminate", "durable_tool_receipt_failed", "Tool receipt could not be persisted before returning its result.", null);
                destroyWebView();
                return;
            }
            respond(callId, result.ok, result.data, result.code, result.status, result.summary);
        }

        void respond(String callId, boolean ok, JSONObject data, String code, String status, String summary) {
            if (webView == null) return;
            JSONObject response = object("type", "response", "call_id", callId, "ok", ok,
                    "data", data == null ? JSONObject.NULL : data, "code", code, "status", status, "error", summary);
            webView.evaluateJavascript("window.__moaResolve(" + response + ")", null);
        }

        void finish(boolean ok, String status, String code, String summary, Object rawResult) {
            if (terminal) return;
            terminal = true;
            String canonicalResult;
            try { canonicalResult = MoaProgramJson.canonical(rawResult); } catch (Exception error) { canonicalResult = "null"; ok = false; status = "failed"; code = "invalid_result"; summary = "Program returned an unsupported result."; }
            if (canonicalResult.getBytes(StandardCharsets.UTF_8).length > proposal.limits.resultBytes) { ok = false; status = "failed"; code = "result_too_large"; summary = "Program result exceeded its byte limit."; canonicalResult = "null"; }
            JSONObject terminalReceipt = MoaSurfaceProgramReceipts.terminal(proposal, clientInstanceId, status, summary,
                    ok ? MoaProgramJson.sha256(canonicalResult) : "", ok ? "" : code, ok ? "" : summary,
                    receipts, startedAtMs, System.currentTimeMillis());
            callback.finished(terminalReceipt, receipts);
        }
    }

    private static JSONObject object(Object... pairs) {
        JSONObject result = new JSONObject();
        try {
            for (int i = 0; i < pairs.length; i += 2) result.put(String.valueOf(pairs[i]), pairs[i + 1]);
            return result;
        } catch (Exception error) {
            throw new IllegalStateException("Unable to encode local runtime message", error);
        }
    }
}
