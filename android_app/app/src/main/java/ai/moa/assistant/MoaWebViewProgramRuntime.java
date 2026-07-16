package ai.moa.assistant;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/** Main-process coordinator for one independently terminable dedicated-process WebView worker. */
final class MoaWebViewProgramRuntime {
    interface Callback { void finished(JSONObject terminalReceipt, JSONArray toolReceipts); }
    interface EngineListener { void call(String payload); void finish(String payload); }
    interface Engine { void start(String source, JSONArray allowed, EngineListener listener); void respond(JSONObject payload); void stop(); }

    private final Handler mainHandler;
    private final MoaAndroidProgramHost host;
    private final MoaSurfaceProgramStore store;
    private final Engine engine;
    private Execution execution;

    MoaWebViewProgramRuntime(Context context, MoaAndroidProgramHost host, MoaSurfaceProgramStore store) {
        this(host, store, new ServiceEngine(context.getApplicationContext()));
    }
    MoaWebViewProgramRuntime(MoaAndroidProgramHost host, MoaSurfaceProgramStore store, Engine engine) {
        this.host = host; this.store = store; this.engine = engine; this.mainHandler = new Handler(Looper.getMainLooper());
    }

    void execute(MoaSurfaceProgramContract.Proposal proposal, String clientId, Callback callback) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post(() -> execute(proposal, clientId, callback)); return; }
        stop("user_stop");
        Execution target = new Execution(proposal, clientId, callback);
        execution = target;
        engine.start(proposal.source, new JSONArray(proposal.allowedCapabilityIds), new EngineListener() {
            public void call(String payload) { mainHandler.post(() -> target.call(payload)); }
            public void finish(String payload) { mainHandler.post(() -> target.workerFinished(payload)); }
        });
        mainHandler.postDelayed(() -> timeout(target), proposal.limits.wallMs);
    }

    void stop(String reason) {
        Execution active = execution;
        if (active != null && !active.terminal) active.finish("stopped", "surface_shutdown".equals(reason) || "overlay_stopped".equals(reason) ? "surface_shutdown" : "user_stop", null);
        engine.stop();
        execution = null;
    }

    private void timeout(Execution target) {
        if (target == null || execution != target || target.terminal) return;
        engine.stop();
        target.finish("timed_out", "timeout", null);
        execution = null;
    }

    private final class Execution {
        final MoaSurfaceProgramContract.Proposal proposal;
        final String clientId;
        final Callback callback;
        final JSONArray receipts = new JSONArray();
        final Set<String> callIds = new HashSet<>();
        final long startedAtMs = System.currentTimeMillis();
        int calls;
        boolean terminal;
        String previousReceiptDigest = "";
        String lastStateDigest;

        Execution(MoaSurfaceProgramContract.Proposal proposal, String clientId, Callback callback) {
            this.proposal = proposal; this.clientId = clientId; this.callback = callback; this.lastStateDigest = proposal.observationDigest;
        }

        void call(String payload) {
            if (terminal || execution != this) return;
            long started = System.currentTimeMillis();
            JSONObject message;
            try { message = new JSONObject(payload); } catch (Exception error) { finish("failed", "runtime_failed", null); return; }
            String callId = message.optString("call_id", "");
            String capabilityId = message.optString("capability_id", "");
            JSONObject input = message.optJSONObject("input");
            if (input == null) input = new JSONObject();
            if (callId.isEmpty() || !callIds.add(callId)) { finish("failed", "runtime_failed", null); return; }
            if (++calls > proposal.limits.toolCalls) { finish("failed", "limit_exceeded", null); return; }
            String inputDigest;
            try { inputDigest = MoaProgramJson.sha256(MoaProgramJson.canonical(input)); }
            catch (Exception error) { respond(callId, false, null, "invalid_input", "rejected", "Capability input was rejected."); return; }
            boolean effectful = MoaScriptExecutionCatalog.isMutation(capabilityId);
            if (!store.beginTool(proposal, clientId, callId, capabilityId, inputDigest, effectful, started)) { finish("failed", "receipt_failed", null); return; }
            MoaAndroidProgramHost.HostResult result = host.call(proposal, capabilityId, input);
            long finished = System.currentTimeMillis();
            JSONObject receipt;
            try { receipt = MoaSurfaceProgramReceipts.toolBound(proposal, clientId, callId, 1, capabilityId, input,
                    result.status, previousReceiptDigest, lastStateDigest, result.postStateSha256, started, finished); }
            catch (Exception error) { finish(effectful ? "indeterminate" : "failed", effectful ? "indeterminate" : "receipt_failed", null); return; }
            if (!store.finishTool(proposal, clientId, callId, capabilityId, receipt, finished)) { finish(effectful ? "indeterminate" : "failed", effectful ? "indeterminate" : "receipt_failed", null); return; }
            previousReceiptDigest = receipt.optString("receipt_sha256", "");
            if (result.postStateSha256 != null) lastStateDigest = result.postStateSha256;
            receipts.put(receipt);
            if (result.isAuthorityDenial()) {
                engine.stop();
                finish("rejected", "policy_denied", null);
                execution = null;
                return;
            }
            respond(callId, result.ok, result.data, result.code, result.status, result.summary);
        }

        void workerFinished(String payload) {
            if (terminal || execution != this) return;
            try {
                JSONObject message = new JSONObject(payload);
                boolean ok = message.optBoolean("ok", false);
                String code = message.optString("code", "");
                boolean policyDenied = !ok && "policy_denied".equals(code);
                finish(ok ? "completed" : policyDenied ? "rejected" : "failed",
                        ok ? null : policyDenied ? "policy_denied" : "runtime_failed", message.opt("result"));
            } catch (Exception error) { finish("failed", "runtime_failed", null); }
            engine.stop(); execution = null;
        }

        void respond(String callId, boolean ok, JSONObject data, String code, String status, String summary) {
            try { engine.respond(new JSONObject().put("type", "response").put("call_id", callId).put("ok", ok)
                    .put("data", data == null ? JSONObject.NULL : data).put("code", code).put("status", status)
                    .put("error", ok ? JSONObject.NULL : safeToolError(status))); }
            catch (Exception error) { finish("failed", "runtime_failed", null); }
        }

        void finish(String status, String code, Object rawResult) {
            if (terminal) return;
            terminal = true;
            try {
                String canonical = MoaProgramJson.canonical(rawResult);
                if (canonical.getBytes(StandardCharsets.UTF_8).length > proposal.limits.resultBytes) { status = "failed"; code = "limit_exceeded"; }
            } catch (Exception error) { status = "failed"; code = "runtime_failed"; }
            JSONObject terminalReceipt = MoaSurfaceProgramReceipts.terminal(proposal, clientId, status, receipts,
                    startedAtMs, System.currentTimeMillis(), lastStateDigest, code);
            if (store.recordTerminal(proposal, clientId, terminalReceipt)) callback.finished(terminalReceipt, receipts);
        }
    }

    private static String safeToolError(String status) { return "stale_state".equals(status) ? "Bound state is stale." : "Local capability ended without success."; }

    /** Messenger client; the WebView and renderer exist only in :moa_program_runtime. */
    static final class ServiceEngine implements Engine, ServiceConnection, Handler.Callback {
        private final Context context;
        private final Messenger inbound;
        private Messenger service;
        private EngineListener listener;
        private String source;
        private JSONArray allowed;
        private boolean bound;

        ServiceEngine(Context context) { this.context = context; inbound = new Messenger(new Handler(Looper.getMainLooper(), this)); }
        public void start(String source, JSONArray allowed, EngineListener listener) {
            stop(); this.source = source; this.allowed = allowed; this.listener = listener;
            bound = context.bindService(new Intent(context, MoaProgramRuntimeService.class), this, Context.BIND_AUTO_CREATE);
            if (!bound) listener.finish("{\"type\":\"terminal\",\"ok\":false,\"code\":\"runtime_failed\"}");
        }
        public void respond(JSONObject payload) { send(MoaProgramRuntimeService.RESPONSE, payload.toString()); }
        public void stop() { send(MoaProgramRuntimeService.STOP, null); if (bound) { try { context.unbindService(this); } catch (Exception ignored) {} } bound = false; service = null; listener = null; }
        public void onServiceConnected(ComponentName name, IBinder binder) { service = new Messenger(binder); Bundle data = new Bundle(); data.putString("source", source); data.putString("allowed_capability_ids", allowed.toString()); Message message = Message.obtain(null, MoaProgramRuntimeService.START); message.setData(data); message.replyTo = inbound; try { service.send(message); } catch (Exception error) { if (listener != null) listener.finish("{\"type\":\"terminal\",\"ok\":false,\"code\":\"runtime_failed\"}"); } }
        public void onServiceDisconnected(ComponentName name) { service = null; if (listener != null) listener.finish("{\"type\":\"terminal\",\"ok\":false,\"code\":\"runtime_failed\"}"); }
        public boolean handleMessage(Message message) { EngineListener target = listener; if (target == null) return true; String payload = message.getData().getString("payload", ""); if (message.what == MoaProgramRuntimeService.CALL) target.call(payload); else if (message.what == MoaProgramRuntimeService.FINISH) target.finish(payload); return true; }
        private void send(int what, String payload) { if (service == null) return; Message message = Message.obtain(null, what); if (payload != null) { Bundle data = new Bundle(); data.putString("payload", payload); message.setData(data); } try { service.send(message); } catch (Exception ignored) {} }
    }
}
