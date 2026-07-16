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
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/** Main-process coordinator for one independently terminable dedicated-process WebView worker. */
final class MoaWebViewProgramRuntime {
    interface Callback { void finished(JSONObject terminalReceipt, JSONArray toolReceipts); }
    interface EngineListener { void call(String executionNonce, long executionGeneration, String payload); void finish(String executionNonce, long executionGeneration, String payload); }
    interface Engine { void start(String executionNonce, long executionGeneration, String source, JSONArray allowed, int logBytes, EngineListener listener); void respond(String executionNonce, long executionGeneration, JSONObject payload); void stop(String executionNonce, long executionGeneration); }

    private static final AtomicLong NEXT_GENERATION = new AtomicLong(android.os.SystemClock.elapsedRealtimeNanos());

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
        Execution target = new Execution(UUID.randomUUID().toString(), nextGeneration(), proposal, clientId, callback);
        execution = target;
        engine.start(target.executionNonce, target.executionGeneration, proposal.source, new JSONArray(proposal.allowedCapabilityIds), proposal.limits.logBytes, new EngineListener() {
            public void call(String nonce, long generation, String payload) { mainHandler.post(() -> { if (target.matches(nonce, generation)) target.call(payload); }); }
            public void finish(String nonce, long generation, String payload) { mainHandler.post(() -> { if (target.matches(nonce, generation)) target.workerFinished(payload); }); }
        });
        mainHandler.postDelayed(() -> timeout(target), proposal.limits.wallMs);
    }

    void stop(String reason) {
        Execution active = execution;
        if (active != null && !active.terminal) active.finish("stopped", "surface_shutdown".equals(reason) || "overlay_stopped".equals(reason) ? "surface_shutdown" : "user_stop", null);
        if (active != null) engine.stop(active.executionNonce, active.executionGeneration);
        execution = null;
    }

    private void timeout(Execution target) {
        if (target == null || execution != target || target.terminal) return;
        engine.stop(target.executionNonce, target.executionGeneration);
        target.finish("timed_out", "timeout", null);
        execution = null;
    }

    private final class Execution {
        final String executionNonce;
        final long executionGeneration;
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

        Execution(String executionNonce, long executionGeneration, MoaSurfaceProgramContract.Proposal proposal, String clientId, Callback callback) {
            this.executionNonce = executionNonce; this.executionGeneration = executionGeneration; this.proposal = proposal; this.clientId = clientId; this.callback = callback; this.lastStateDigest = proposal.observationDigest;
        }
        boolean matches(String nonce, long generation) { return executionNonce.equals(nonce) && executionGeneration == generation; }

        void call(String payload) {
            if (terminal || execution != this) return;
            long started = System.currentTimeMillis();
            JSONObject message;
            try { message = new JSONObject(payload); } catch (Exception error) { finish("failed", "runtime_failed", null); return; }
            Set<String> envelopeKeys = new HashSet<>(); java.util.Iterator<String> envelopeIterator = message.keys();
            while (envelopeIterator.hasNext()) envelopeKeys.add(envelopeIterator.next());
            if (!envelopeKeys.equals(Set.of("type", "call_id", "capability_id", "input")) || !"call".equals(message.optString("type"))
                    || !(message.opt("input") instanceof JSONObject)) { finish("failed", "runtime_failed", null); return; }
            String callId = message.optString("call_id", "");
            String capabilityId = message.optString("capability_id", "");
            JSONObject input = message.optJSONObject("input");
            if (callId.isEmpty() || !callIds.add(callId)) { finish("failed", "runtime_failed", null); return; }
            if (++calls > proposal.limits.toolCalls) { finish("failed", "limit_exceeded", null); return; }
            String inputDigest;
            try { inputDigest = MoaProgramJson.sha256(MoaProgramJson.canonical(input)); }
            catch (Exception error) { respond(callId, false, null, "invalid_input", "rejected", "Capability input was rejected."); return; }
            boolean effectful = MoaScriptExecutionCatalog.isMutation(capabilityId);
            if (!store.beginTool(proposal, clientId, callId, capabilityId, inputDigest, effectful, started)) { finish("failed", "receipt_failed", null); return; }
            MoaAndroidProgramHost.HostResult result = host.call(proposal, capabilityId, input);
            long finished = System.currentTimeMillis();
            boolean stateIndeterminate = effectful && ("indeterminate".equals(result.status)
                    || (result.ok && result.postStateSha256 == null));
            JSONObject receipt;
            try { receipt = MoaSurfaceProgramReceipts.toolBound(proposal, clientId, callId, 1, capabilityId, input,
                    stateIndeterminate ? "indeterminate" : result.status, previousReceiptDigest, lastStateDigest,
                    result.postStateSha256, started, finished); }
            catch (Exception error) {
                if (effectful) { lastStateDigest = null; engine.stop(executionNonce, executionGeneration); }
                try {
                    JSONObject fallbackReceipt = MoaSurfaceProgramReceipts.toolBound(proposal, clientId, callId, 1, capabilityId, input,
                            effectful ? "indeterminate" : "failed", previousReceiptDigest, lastStateDigest,
                            null, started, finished);
                    if (store.finishTool(proposal, clientId, callId, capabilityId, fallbackReceipt, finished)) {
                        previousReceiptDigest = fallbackReceipt.optString("receipt_sha256", "");
                        receipts.put(fallbackReceipt);
                    }
                } catch (Exception ignored) {
                    // Recovery retains the durable pending attempt when even the closed fallback cannot be committed.
                }
                finish(effectful ? "indeterminate" : "failed", effectful ? "indeterminate" : "receipt_failed", null);
                if (effectful) execution = null;
                return;
            }
            if (!store.finishTool(proposal, clientId, callId, capabilityId, receipt, finished)) { finish(effectful ? "indeterminate" : "failed", effectful ? "indeterminate" : "receipt_failed", null); return; }
            previousReceiptDigest = receipt.optString("receipt_sha256", "");
            if (result.postStateSha256 != null) lastStateDigest = result.postStateSha256;
            receipts.put(receipt);
            if (stateIndeterminate) {
                lastStateDigest = null;
                engine.stop(executionNonce, executionGeneration);
                finish("indeterminate", "indeterminate", null);
                execution = null;
                return;
            }
            if (result.isAuthorityDenial()) {
                engine.stop(executionNonce, executionGeneration);
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
            engine.stop(executionNonce, executionGeneration); execution = null;
        }

        void respond(String callId, boolean ok, JSONObject data, String code, String status, String summary) {
            try { engine.respond(executionNonce, executionGeneration, new JSONObject().put("type", "response").put("call_id", callId).put("ok", ok)
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
    static final class ServiceEngine implements Engine, Handler.Callback {
        private final Context context;
        private final Messenger inbound;
        private Messenger service;
        private EngineListener listener;
        private String source;
        private JSONArray allowed;
        private int logBytes;
        private String executionNonce;
        private long executionGeneration;
        private boolean bound;
        private long connectionGeneration;
        private ServiceConnection connection;

        ServiceEngine(Context context) { this.context = context; inbound = new Messenger(new Handler(Looper.getMainLooper(), this)); }
        public void start(String executionNonce, long executionGeneration, String source, JSONArray allowed, int logBytes, EngineListener listener) {
            stop(this.executionNonce, this.executionGeneration); this.executionNonce = executionNonce; this.executionGeneration = executionGeneration; this.source = source; this.allowed = allowed; this.logBytes = logBytes; this.listener = listener;
            long bindingGeneration = ++connectionGeneration;
            connection = new RunConnection(bindingGeneration, executionNonce, executionGeneration);
            bound = context.bindService(new Intent(context, MoaProgramRuntimeService.class), connection, Context.BIND_AUTO_CREATE);
            if (!bound) listener.finish(executionNonce, executionGeneration, "{\"type\":\"terminal\",\"ok\":false,\"code\":\"runtime_failed\"}");
        }
        public void respond(String nonce, long generation, JSONObject payload) { send(MoaProgramRuntimeService.RESPONSE, nonce, generation, payload.toString()); }
        public void stop(String nonce, long generation) { if (executionNonce != null && (!executionNonce.equals(nonce) || executionGeneration != generation)) return; send(MoaProgramRuntimeService.STOP, nonce, generation, null); ServiceConnection active = connection; if (bound && active != null) { try { context.unbindService(active); } catch (Exception ignored) {} } connectionGeneration++; bound = false; connection = null; service = null; listener = null; executionNonce = null; executionGeneration = 0; }
        void onServiceConnected(ComponentName name, IBinder binder) { connected(connectionGeneration, executionNonce, executionGeneration, binder); }
        void onServiceDisconnected(ComponentName name) { disconnected(connectionGeneration, executionNonce, executionGeneration); }
        public boolean handleMessage(Message message) { EngineListener target = listener; if (target == null) return true; String nonce = message.getData().getString("execution_nonce", ""); long generation = message.getData().getLong("execution_generation", -1); if (!nonce.equals(executionNonce) || generation != executionGeneration) return true; String payload = message.getData().getString("payload", ""); if (message.what == MoaProgramRuntimeService.CALL) target.call(nonce, generation, payload); else if (message.what == MoaProgramRuntimeService.FINISH) target.finish(nonce, generation, payload); return true; }
        private void send(int what, String nonce, long generation, String payload) { if (service == null || nonce == null || !nonce.equals(executionNonce) || generation != executionGeneration) return; Message message = Message.obtain(null, what); Bundle data = new Bundle(); data.putString("execution_nonce", nonce); data.putLong("execution_generation", generation); if (payload != null) data.putString("payload", payload); message.setData(data); try { service.send(message); } catch (Exception ignored) {} }
        private void connected(long bindingGeneration, String nonce, long generation, IBinder binder) { if (bindingGeneration != connectionGeneration || nonce == null || !nonce.equals(executionNonce) || generation != executionGeneration) return; service = new Messenger(binder); Bundle data = new Bundle(); data.putString("execution_nonce", nonce); data.putLong("execution_generation", generation); data.putString("source", source); data.putString("allowed_capability_ids", allowed.toString()); data.putInt("log_bytes", logBytes); Message message = Message.obtain(null, MoaProgramRuntimeService.START); message.setData(data); message.replyTo = inbound; try { service.send(message); } catch (Exception error) { if (listener != null) listener.finish(nonce, generation, "{\"type\":\"terminal\",\"ok\":false,\"code\":\"runtime_failed\"}"); } }
        private void disconnected(long bindingGeneration, String nonce, long generation) { if (bindingGeneration != connectionGeneration || nonce == null || !nonce.equals(executionNonce) || generation != executionGeneration) return; service = null; EngineListener target = listener; if (target != null) target.finish(nonce, generation, "{\"type\":\"terminal\",\"ok\":false,\"code\":\"runtime_failed\"}"); }
        private final class RunConnection implements ServiceConnection {
            final long bindingGeneration, executionGeneration; final String nonce;
            RunConnection(long bindingGeneration, String nonce, long executionGeneration) { this.bindingGeneration = bindingGeneration; this.nonce = nonce; this.executionGeneration = executionGeneration; }
            public void onServiceConnected(ComponentName name, IBinder binder) { connected(bindingGeneration, nonce, executionGeneration, binder); }
            public void onServiceDisconnected(ComponentName name) { disconnected(bindingGeneration, nonce, executionGeneration); }
        }
    }

    private static synchronized long nextGeneration() {
        long candidate = Math.max(NEXT_GENERATION.get() + 1, android.os.SystemClock.elapsedRealtimeNanos());
        NEXT_GENERATION.set(candidate);
        return candidate;
    }
}
