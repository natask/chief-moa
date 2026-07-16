package ai.moa.assistant;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class MoaSurfaceProgramCoordinatorTest {
    private static final long NOW = 1_800_000_000_000L;
    private MoaSurfaceProgramStore store;
    private Context context;
    private FakeRuntime runtime;
    private final List<String> rejected = new ArrayList<>();
    private final List<String> paths = new ArrayList<>();
    private boolean binding = true;
    private boolean transportFails;
    private boolean corruptAck;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        store = new MoaSurfaceProgramStore(context);
        runtime = new FakeRuntime();
        rejected.clear(); paths.clear(); binding = true; transportFails = false; corruptAck = false;
    }

    @Test public void validProposalIsDurableBeforeRuntimeAndCompletionSchedulesDrain() throws Exception {
        MoaSurfaceProgramCoordinator coordinator = coordinator(Runnable::run, 16);
        coordinator.execute("request_1", valid());
        assertEquals(1, runtime.starts);
        JSONObject entry = store.existing("exec_fixture", "idem_fixture");
        assertEquals("pending", entry.getString("status"));
        assertEquals(2, entry.getJSONArray("events").length());
        runtime.complete();
        assertEquals(List.of("/v1/tool/requests/request_1/events", "/v1/tool/requests/request_1/events",
                "/v1/tool/requests/request_1/receipts", "/v1/tool/requests/request_1/events"), paths);
        assertNull(store.nextSyncDelivery("exec_fixture"));
    }

    @Test public void invalidProposalWithSafeIdentityGetsExactDurableTerminal() throws Exception {
        JSONObject invalid = valid().put("unexpected", true);
        coordinator(Runnable::run, 16).execute("request_bad", invalid);
        assertTrue(rejected.isEmpty());
        assertEquals(List.of("/v1/tool/requests/request_bad/receipts", "/v1/tool/requests/request_bad/events"), paths);
        JSONObject entry = store.existing("exec_fixture", "idem_fixture");
        assertEquals("rejected", entry.getString("status"));
        assertEquals("proposal_rejected", entry.getJSONObject("terminal").getJSONObject("error").getString("code"));
    }

    @Test public void undecodableAndMissingRequestAreRejectedWithoutExecution() throws Exception {
        MoaSurfaceProgramCoordinator coordinator = coordinator(Runnable::run, 16);
        coordinator.execute("request_bad", new JSONObject());
        coordinator.execute("", valid());
        assertEquals(List.of("request_bad:invalid_envelope_shape", ":request_id_required"), rejected);
        assertTrue(paths.isEmpty());
        assertEquals(0, runtime.starts);
    }

    @Test public void invalidDuplicateGetsSeparateDurableRejectionAndEmptyRequestDoesNot() throws Exception {
        assertTrue(store.recordPending(proposal(valid()), "client", "request_original"));
        JSONObject invalid = valid().put("unexpected", true);
        MoaSurfaceProgramCoordinator coordinator = coordinator(Runnable::run, 16);
        coordinator.execute("request_invalid", invalid);
        coordinator.execute("", invalid);
        coordinator.execute(null, invalid);
        coordinator.execute(null, valid());
        assertEquals(List.of("/v1/tool/requests/request_invalid/receipts", "/v1/tool/requests/request_invalid/events"), paths);
        assertEquals(List.of(":invalid_envelope_shape", "null:invalid_envelope_shape", ":request_id_required"), rejected);
    }

    @Test public void approvalAndStaleBindingAreDurableRejections() throws Exception {
        JSONObject ask = valid();
        ask.getJSONObject("approval_policy").put("program", "approval_required");
        coordinator(Runnable::run, 16).execute("request_ask", ask);
        assertEquals("policy_denied", store.existing("exec_fixture", "idem_fixture").getJSONObject("terminal").getJSONObject("error").getString("code"));

        setNewIdentity(ask, "stale");
        ask.getJSONObject("approval_policy").put("program", "local_policy");
        binding = false;
        coordinator(Runnable::run, 16).execute("request_stale", ask);
        assertEquals("stale_state", store.existing("exec_stale", "idem_stale").getJSONObject("terminal").getJSONObject("error").getString("code"));
        assertEquals(0, runtime.starts);
    }

    @Test public void acceptedReplayRestartsOnceButActiveDuplicateDoesNot() throws Exception {
        MoaSurfaceProgramContract.Proposal proposal = proposal(valid());
        assertTrue(store.recordPending(proposal, "client", "request_1"));
        MoaSurfaceProgramCoordinator coordinator = coordinator(command -> {}, 16);
        coordinator.execute("request_1", valid());
        coordinator.execute("request_1", valid());
        assertEquals(1, runtime.starts);
    }

    @Test public void replayBetweenDurablePendingAndOriginalStartHasSingleRuntimeWinner() throws Exception {
        BlockingFirstExecutor executor = new BlockingFirstExecutor();
        MoaSurfaceProgramCoordinator coordinator = coordinator(executor, 16);
        Thread original = new Thread(() -> coordinator.execute("request_1", validUnchecked()));
        original.start();
        assertTrue(executor.firstScheduled.await(5, TimeUnit.SECONDS));

        coordinator.execute("request_1", valid());
        assertEquals(1, runtime.starts);

        executor.releaseFirst.countDown();
        original.join(5_000);
        assertFalse(original.isAlive());
        assertEquals(1, runtime.starts);
    }

    @Test public void replayWithPendingAttemptRecoversIndeterminateWithoutRuntime() throws Exception {
        MoaSurfaceProgramContract.Proposal proposal = proposal(valid());
        assertTrue(store.recordPending(proposal, "client", "request_1"));
        assertTrue(store.beginTool(proposal, "client", "call_1", MoaScriptExecutionCatalog.CLICK,
                "1".repeat(64), true, NOW));
        coordinator(Runnable::run, 16).execute("request_1", valid());
        assertEquals(0, runtime.starts);
        assertEquals("indeterminate", store.existing("exec_fixture", "idem_fixture").getJSONObject("terminal").getString("status"));
        assertTrue(paths.contains("/v1/tool/requests/request_1/tool-receipts"));
    }

    @Test public void corruptPendingAttemptFailsClosedAndTerminalReplayOnlyDrains() throws Exception {
        MoaSurfaceProgramContract.Proposal proposal = proposal(valid());
        assertTrue(store.recordPending(proposal, "client", "request_1"));
        assertTrue(store.beginTool(proposal, "client", "call_1", MoaScriptExecutionCatalog.OBSERVE,
                "1".repeat(64), false, NOW));
        JSONArray entries = persisted();
        entries.getJSONObject(0).getJSONArray("pending_attempts").getJSONObject(0).put("started_at", "bad");
        persist(entries);
        coordinator(Runnable::run, 16).execute("request_1", valid());
        assertEquals(List.of("request_1:recovery_failed"), rejected);
        assertEquals(0, runtime.starts);

        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        assertTrue(store.recordPending(proposal, "client", "request_1"));
        JSONObject terminal = MoaSurfaceProgramReceipts.terminal(proposal, "client", "completed", new JSONArray(), NOW, NOW + 1, null, null);
        assertTrue(store.recordTerminal(proposal, "client", terminal));
        coordinator(Runnable::run, 16).execute("request_1", valid());
        assertEquals(0, runtime.starts);
        assertNull(store.nextSyncDelivery("exec_fixture"));
    }

    @Test public void proposalCollisionCreatesNewDurableOutboxAndNeverRetargetsOriginal() throws Exception {
        JSONObject original = valid();
        MoaSurfaceProgramContract.Proposal first = proposal(original);
        assertTrue(store.recordPending(first, "client", "request_original"));
        JSONObject changed = valid();
        changed.getJSONObject("program").put("source", "async function main(){return 2;}");
        changed.getJSONObject("program").put("sha256", MoaProgramJson.sha256("async function main(){return 2;}"));
        coordinator(Runnable::run, 16).execute("request_collision", changed);
        assertEquals("request_original", store.existing("exec_fixture", "idem_fixture").getString("request_id"));
        assertEquals(List.of("/v1/tool/requests/request_collision/receipts", "/v1/tool/requests/request_collision/events"), paths);
        coordinator(Runnable::run, 16).execute("request_collision", changed);
        assertEquals(2, paths.size());
        assertEquals(0, runtime.starts);
    }

    @Test public void requestBindingConflictDoesNotRetargetReplay() throws Exception {
        assertTrue(store.recordPending(proposal(valid()), "client", "request_old"));
        coordinator(Runnable::run, 16).execute("request_new", valid());
        assertEquals(List.of("request_new:request_binding_conflict"), rejected);
        assertEquals("request_old", store.existing("exec_fixture", "idem_fixture").getString("request_id"));
    }

    @Test public void boundedDrainAndTransportFailurePreserveCursor() throws Exception {
        assertTrue(store.recordPending(proposal(valid()), "client", "request_1"));
        JSONObject second = valid(); setNewIdentity(second, "second");
        assertTrue(store.recordPending(proposal(second), "client", "request_2"));
        MoaSurfaceProgramCoordinator coordinator = coordinator(Runnable::run, 1);
        assertEquals(0, coordinator.drainExecution(transport(), "exec_fixture", 0));
        assertEquals(1, coordinator.drainPending(transport()));
        assertEquals("event:1", store.nextSyncDelivery("exec_fixture").getString("delivery_id"));
        transportFails = true;
        try { coordinator.drainPending(transport()); fail(); } catch (Exception expected) { assertEquals("offline", expected.getMessage()); }
        assertEquals("event:1", store.nextSyncDelivery("exec_fixture").getString("delivery_id"));
    }

    @Test public void emptyDrainDefaultBatchAndAckFailureAreBounded() throws Exception {
        MoaSurfaceProgramCoordinator defaultCoordinator = new MoaSurfaceProgramCoordinator(store, runtime,
                proposal -> true, this::transport, (id, code) -> {}, () -> NOW, Runnable::run,
                "android_fixture", "client");
        assertEquals(0, defaultCoordinator.drainPending(transport()));
        assertTrue(store.recordPending(proposal(valid()), "client", "request_1"));
        corruptAck = true;
        assertEquals(1, defaultCoordinator.drainExecution(transport(), "exec_fixture", 16));
    }

    @Test public void scheduledTransportFailureIsRetriedByLaterDrainAndStopDelegates() throws Exception {
        transportFails = true;
        MoaSurfaceProgramCoordinator coordinator = coordinator(Runnable::run, 16);
        coordinator.execute("request_1", valid());
        runtime.complete();
        assertNotNull(store.nextSyncDelivery("exec_fixture"));
        transportFails = false;
        assertEquals(4, coordinator.drainPending(transport()));
        coordinator.stop("surface_shutdown");
        assertEquals("surface_shutdown", runtime.stopped);
    }

    @Test public void persistenceFailuresFailClosedAtAdmissionRejectionAndCollision() throws Exception {
        ControlledPersistence persistence = new ControlledPersistence();
        store = new MoaSurfaceProgramStore(persistence);
        persistence.failNext();
        coordinator(Runnable::run, 16).execute("request_pending", valid());
        assertEquals(List.of("request_pending:durable_pending_failed"), rejected);

        rejected.clear();
        JSONObject ask = valid(); ask.getJSONObject("approval_policy").put("program", "approval_required");
        persistence.allowWrites();
        persistence.failNext();
        coordinator(Runnable::run, 16).execute("request_rejected", ask);
        assertEquals(List.of("request_rejected:durable_rejection_failed"), rejected);

        rejected.clear();
        persistence.allowWrites();
        assertTrue(store.recordPending(proposal(valid()), "client", "request_original"));
        JSONObject changed = valid();
        changed.getJSONObject("program").put("source", "async function main(){return 3;}");
        changed.getJSONObject("program").put("sha256", MoaProgramJson.sha256("async function main(){return 3;}"));
        persistence.failNext();
        coordinator(Runnable::run, 16).execute("request_collision", changed);
        assertEquals(List.of("request_collision:durable_rejection_failed"), rejected);
    }

    @Test public void recoveryPersistenceFailuresDoNotProduceTerminalClaims() throws Exception {
        ControlledPersistence persistence = new ControlledPersistence();
        store = new MoaSurfaceProgramStore(persistence);
        MoaSurfaceProgramContract.Proposal proposal = proposal(valid());
        assertTrue(store.recordPending(proposal, "client", "request_1"));
        assertTrue(store.beginTool(proposal, "client", "call_1", MoaScriptExecutionCatalog.OBSERVE,
                "1".repeat(64), false, NOW));
        persistence.failNext();
        assertNull(store.recoverIndeterminate(proposal, "client"));
        JSONObject retained = store.existing(proposal.executionId, proposal.idempotencyKey);
        assertTrue(store.hasPendingAttempt(retained));
        assertNull(retained.optJSONObject("terminal"));
        persistence.allowWrites();
        assertNotNull(store.recoverIndeterminate(proposal, "client"));

        persistence = new ControlledPersistence();
        store = new MoaSurfaceProgramStore(persistence);
        assertTrue(store.recordPending(proposal, "client", "request_1"));
        assertTrue(store.beginTool(proposal, "client", "call_1", MoaScriptExecutionCatalog.OBSERVE,
                "1".repeat(64), false, NOW));
        persistence.failAfterSuccessfulWrites(1);
        assertNotNull(store.recoverIndeterminate(proposal, "client"));
        JSONObject recovered = store.existing(proposal.executionId, proposal.idempotencyKey);
        assertFalse(store.hasPendingAttempt(recovered));
        assertEquals("indeterminate", recovered.getString("status"));
        assertNotNull(recovered.getJSONObject("terminal"));
    }

    private MoaSurfaceProgramCoordinator coordinator(Executor executor, int batch) {
        return new MoaSurfaceProgramCoordinator(store, runtime, proposal -> binding, this::transport,
                (requestId, code) -> rejected.add(String.valueOf(requestId) + ":" + code), () -> NOW,
                executor, "android_fixture", "client", batch);
    }

    private MoaSurfaceProgramTransport transport() {
        return new MoaSurfaceProgramTransport((path, body, timeout) -> {
            if (transportFails) throw new Exception("offline");
            paths.add(path);
            assertEquals(15_000, timeout);
            if (corruptAck) {
                JSONArray entries = persisted();
                entries.getJSONObject(0).getJSONObject("sync").put("event_index", 99);
                persist(entries);
            }
            return new JSONObject().put("ok", true);
        });
    }

    private final class FakeRuntime implements MoaSurfaceProgramCoordinator.Runtime {
        int starts;
        String stopped;
        MoaSurfaceProgramContract.Proposal proposal;
        MoaSurfaceProgramCoordinator.Completion completion;
        public void execute(MoaSurfaceProgramContract.Proposal proposal, String clientId,
                            MoaSurfaceProgramCoordinator.Completion completion) {
            starts++; this.proposal = proposal; this.completion = completion;
        }
        public void stop(String reason) { stopped = reason; }
        void complete() {
            JSONObject terminal = MoaSurfaceProgramReceipts.terminal(proposal, "client", "completed",
                    new JSONArray(), NOW, NOW + 1, null, null);
            assertTrue(store.recordTerminal(proposal, "client", terminal));
            completion.finished(terminal, new JSONArray());
        }
    }

    private static final class ControlledPersistence implements MoaSurfaceProgramStore.Persistence {
        String value = "[]";
        int successfulWritesBeforeFailure = Integer.MAX_VALUE;
        public String read() { return value; }
        public boolean write(String next) {
            if (successfulWritesBeforeFailure == 0) return false;
            successfulWritesBeforeFailure--;
            value = next;
            return true;
        }
        void failNext() { successfulWritesBeforeFailure = 0; }
        void failAfterSuccessfulWrites(int count) { successfulWritesBeforeFailure = count; }
        void allowWrites() { successfulWritesBeforeFailure = Integer.MAX_VALUE; }
    }

    private static final class BlockingFirstExecutor implements Executor {
        final CountDownLatch firstScheduled = new CountDownLatch(1);
        final CountDownLatch releaseFirst = new CountDownLatch(1);
        final AtomicInteger submissions = new AtomicInteger();
        public void execute(Runnable command) {
            if (submissions.incrementAndGet() != 1) return;
            firstScheduled.countDown();
            try { assertTrue(releaseFirst.await(5, TimeUnit.SECONDS)); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); fail("Interrupted while staging coordinator race"); }
        }
    }

    private static JSONObject valid() throws Exception { return MoaSurfaceProgramContractTest.valid(); }
    private static JSONObject validUnchecked() {
        try { return valid(); }
        catch (Exception error) { throw new AssertionError(error); }
    }
    private static MoaSurfaceProgramContract.Proposal proposal(JSONObject input) {
        return MoaSurfaceProgramContract.parse(input, "android_fixture", NOW);
    }
    private static void setNewIdentity(JSONObject input, String suffix) throws Exception {
        input.put("execution_id", "exec_" + suffix).put("idempotency_key", "idem_" + suffix);
    }
    private JSONArray persisted() throws Exception {
        return new JSONArray(context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE)
                .getString("entries", "[]"));
    }
    private void persist(JSONArray entries) {
        assertTrue(context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE)
                .edit().putString("entries", entries.toString()).commit());
    }
}
