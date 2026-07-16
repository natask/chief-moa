package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.Executor;
import java.util.HashSet;
import java.util.Set;

/** Owns proposal admission, durable replay/recovery, runtime scheduling, and bounded outbox delivery. */
final class MoaSurfaceProgramCoordinator {
    static final int DEFAULT_SYNC_BATCH = 16;

    interface Runtime {
        void execute(MoaSurfaceProgramContract.Proposal proposal, String clientId, Completion completion);
        void stop(String reason);
    }
    interface Completion { void finished(JSONObject terminal, JSONArray toolReceipts); }
    interface BindingAuthority { boolean matches(MoaSurfaceProgramContract.Proposal proposal); }
    interface TransportFactory { MoaSurfaceProgramTransport create(); }
    interface RejectSink { void reject(String requestId, String code); }
    interface Clock { long now(); }

    private final MoaSurfaceProgramStore store;
    private final Runtime runtime;
    private final BindingAuthority binding;
    private final TransportFactory transports;
    private final RejectSink rejectSink;
    private final Clock clock;
    private final Executor executor;
    private final String deviceId;
    private final String clientId;
    private final int syncBatch;
    private final Object deliveryLock = new Object();
    private final Set<String> activeExecutions = new HashSet<>();

    MoaSurfaceProgramCoordinator(MoaSurfaceProgramStore store, Runtime runtime, BindingAuthority binding,
                                 TransportFactory transports, RejectSink rejectSink, Clock clock,
                                 Executor executor, String deviceId, String clientId) {
        this(store, runtime, binding, transports, rejectSink, clock, executor, deviceId, clientId, DEFAULT_SYNC_BATCH);
    }

    MoaSurfaceProgramCoordinator(MoaSurfaceProgramStore store, Runtime runtime, BindingAuthority binding,
                                 TransportFactory transports, RejectSink rejectSink, Clock clock,
                                 Executor executor, String deviceId, String clientId, int syncBatch) {
        this.store = store;
        this.runtime = runtime;
        this.binding = binding;
        this.transports = transports;
        this.rejectSink = rejectSink;
        this.clock = clock;
        this.executor = executor;
        this.deviceId = deviceId;
        this.clientId = clientId;
        this.syncBatch = Math.max(1, syncBatch);
    }

    void execute(String requestId, JSONObject input) {
        final MoaSurfaceProgramContract.Proposal proposal;
        try {
            proposal = MoaSurfaceProgramContract.parse(input, deviceId, clock.now());
        } catch (MoaSurfaceProgramContract.Rejected rejected) {
            MoaSurfaceProgramContract.Proposal identity = MoaSurfaceProgramContract.receiptIdentity(input, deviceId);
            if (identity == null || requestId == null || requestId.trim().isEmpty()) {
                rejectSink.reject(requestId, rejected.code);
            } else {
                JSONObject prior = store.existing(identity.executionId, identity.idempotencyKey);
                if (prior == null) rejectAndSchedule(identity, requestId, "proposal_rejected");
                else {
                    String syncKey = store.recordCollisionRejected(identity, clientId, requestId);
                    if (syncKey == null) rejectSink.reject(requestId, "durable_rejection_failed");
                    else schedule(syncKey);
                }
            }
            return;
        }
        if (requestId == null || requestId.trim().isEmpty()) {
            rejectSink.reject("", "request_id_required");
            return;
        }
        if ("approval_required".equals(proposal.programApproval)) {
            rejectAndSchedule(proposal, requestId, "policy_denied");
            return;
        }

        JSONObject replay = store.existing(proposal.executionId, proposal.idempotencyKey);
        if (replay != null) {
            replay(proposal, requestId, replay);
            return;
        }
        if (!binding.matches(proposal)) {
            rejectAndSchedule(proposal, requestId, "stale_state");
            return;
        }
        if (!store.recordPending(proposal, clientId, requestId)) {
            rejectSink.reject(requestId, "durable_pending_failed");
            return;
        }
        schedule(proposal.executionId);
        start(proposal);
    }

    void stop(String reason) { runtime.stop(reason); }

    int drainPending(MoaSurfaceProgramTransport transport) throws Exception {
        JSONArray pending = store.pendingSyncEntries();
        int remaining = syncBatch;
        for (int i = 0; i < pending.length() && remaining > 0; i++) {
            JSONObject entry = pending.getJSONObject(i);
            remaining -= drainExecution(transport, entry.optString("sync_key", entry.optString("execution_id")), remaining);
        }
        return syncBatch - remaining;
    }

    int drainExecution(MoaSurfaceProgramTransport transport, String executionId, int limit) throws Exception {
        if (limit <= 0) return 0;
        synchronized (deliveryLock) {
            int delivered = 0;
            while (delivered < limit) {
                JSONObject delivery = store.nextSyncDelivery(executionId);
                if (delivery == null) return delivered;
                transport.deliver(delivery.getString("request_id"), delivery.getString("kind"),
                        delivery.getJSONObject("payload"));
                delivered++;
                if (!store.acknowledgeSyncDelivery(executionId, delivery.getString("delivery_id"))) return delivered;
            }
            return delivered;
        }
    }

    private void replay(MoaSurfaceProgramContract.Proposal proposal, String requestId, JSONObject entry) {
        if (!proposal.proposalSha256.equals(entry.optString("proposal_sha256"))) {
            String syncKey = store.recordCollisionRejected(proposal, clientId, requestId);
            if (syncKey == null) rejectSink.reject(requestId, "durable_rejection_failed");
            else schedule(syncKey);
            return;
        }
        if (!store.bindRequest(proposal.executionId, proposal.idempotencyKey, requestId)) {
            rejectSink.reject(requestId, "request_binding_conflict");
            return;
        }
        JSONObject rebound = store.existing(proposal.executionId, proposal.idempotencyKey);
        if (rebound.optJSONObject("terminal") == null) {
            if (store.hasPendingAttempt(rebound)) {
                if (store.recoverIndeterminate(proposal, clientId) == null) {
                    rejectSink.reject(requestId, "recovery_failed");
                    return;
                }
            } else if (markActive(proposal.executionId)) {
                runMarked(proposal);
            }
        }
        schedule(proposal.executionId);
    }

    private void rejectAndSchedule(MoaSurfaceProgramContract.Proposal proposal, String requestId, String code) {
        if (store.recordRejected(proposal, clientId, requestId, code) == null) {
            rejectSink.reject(requestId, "durable_rejection_failed");
            return;
        }
        schedule(proposal.executionId);
    }

    private void schedule(String executionId) {
        executor.execute(() -> {
            try { drainExecution(transports.create(), executionId, syncBatch); }
            catch (Exception ignored) { /* The durable cursor is retried by the device polling loop. */ }
        });
    }

    private void start(MoaSurfaceProgramContract.Proposal proposal) {
        markActive(proposal.executionId);
        runMarked(proposal);
    }

    private void runMarked(MoaSurfaceProgramContract.Proposal proposal) {
        runtime.execute(proposal, clientId, (terminal, receipts) -> {
            synchronized (activeExecutions) { activeExecutions.remove(proposal.executionId); }
            schedule(proposal.executionId);
        });
    }

    private boolean markActive(String executionId) {
        synchronized (activeExecutions) { return activeExecutions.add(executionId); }
    }

}
