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

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public final class MoaSurfaceProgramOutboxTest {
    private Context context;
    private MoaSurfaceProgramContract.Proposal proposal;
    private MoaSurfaceProgramStore store;

    @Before public void setUp() throws Exception {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        proposal = MoaSurfaceProgramContract.parse(MoaSurfaceProgramContractTest.valid(), "android_fixture", 1_800_000_000_000L);
        store = new MoaSurfaceProgramStore(context);
    }

    @Test public void outboxAdvancesOnlyAfterEachAcknowledgementAndSurvivesRecreation() throws Exception {
        assertTrue(store.recordPending(proposal, "client", "request_1"));
        JSONObject first = store.nextSyncDelivery(proposal.executionId);
        assertEquals("event:0", first.getString("delivery_id"));
        assertEquals("accepted", first.getJSONObject("payload").getString("kind"));
        assertEquals(first.toString(), store.nextSyncDelivery(proposal.executionId).toString());
        assertFalse(store.acknowledgeSyncDelivery(proposal.executionId, "event:99"));
        assertTrue(store.acknowledgeSyncDelivery(proposal.executionId, "event:0"));

        store = new MoaSurfaceProgramStore(context);
        assertEquals("event:1", store.nextSyncDelivery(proposal.executionId).getString("delivery_id"));
        assertTrue(store.acknowledgeSyncDelivery(proposal.executionId, "event:1"));

        assertTrue(store.beginTool(proposal, "client", "read_1", MoaScriptExecutionCatalog.OBSERVE, "1".repeat(64), false, 10));
        JSONObject receipt = MoaSurfaceProgramReceipts.toolBound(proposal, "client", "read_1", 1,
                MoaScriptExecutionCatalog.OBSERVE, new JSONObject(), "succeeded", "", proposal.observationDigest, null, 10, 11);
        assertTrue(store.finishTool(proposal, "client", "read_1", MoaScriptExecutionCatalog.OBSERVE, receipt, 11));
        JSONObject terminal = MoaSurfaceProgramReceipts.terminal(proposal, "client", "completed", new JSONArray().put(receipt), 9, 12, null, null);
        assertTrue(store.recordTerminal(proposal, "client", terminal));

        assertDelivery("event:2", "event");
        assertDelivery("prerequisite:3", "tool_receipt");
        assertDelivery("event:3", "event");
        assertDelivery("prerequisite:4", "terminal_receipt");
        assertDelivery("event:4", "event");
        assertNull(store.nextSyncDelivery(proposal.executionId));
        assertEquals(0, store.pendingSyncEntries().length());
    }

    @Test public void requestBindingIsDurableAndCannotBeRetargeted() {
        assertTrue(store.recordPending(proposal, "client"));
        assertTrue(store.bindRequest(proposal.executionId, proposal.idempotencyKey, "request_1"));
        assertEquals("request_1", store.nextSyncDelivery(proposal.executionId).optString("request_id"));
        assertTrue(store.bindRequest(proposal.executionId, proposal.idempotencyKey, "request_1"));
        assertFalse(store.bindRequest(proposal.executionId, proposal.idempotencyKey, "request_2"));
        assertFalse(store.bindRequest("missing", "missing", "request_1"));
        assertFalse(store.bindRequest(proposal.executionId, proposal.idempotencyKey, ""));
    }

    @Test public void readAttemptIsRecoveredAndTerminalUsesDurableStartedEvent() throws Exception {
        assertTrue(store.recordPending(proposal, "client", "request_1"));
        JSONObject before = store.existing(proposal.executionId, proposal.idempotencyKey);
        String durableStarted = before.getJSONArray("events").getJSONObject(1).getString("occurred_at");
        assertTrue(store.beginTool(proposal, "client", "read_crash", MoaScriptExecutionCatalog.OBSERVE, "2".repeat(64), false, 10));
        before = store.existing(proposal.executionId, proposal.idempotencyKey);
        assertTrue(store.hasPendingAttempt(before));
        assertFalse(store.hasPendingEffect(before));

        assertNotNull(store.recoverIndeterminate(proposal, "client"));
        JSONObject recovered = store.existing(proposal.executionId, proposal.idempotencyKey);
        assertEquals("indeterminate", recovered.getJSONObject("terminal").getString("status"));
        assertEquals(durableStarted, recovered.getJSONObject("terminal").getString("started_at"));
        assertEquals("indeterminate", recovered.getJSONArray("tool_receipts").getJSONObject(0).getString("status"));
        assertFalse(store.hasPendingAttempt(recovered));
        assertNull(store.recoverIndeterminate(proposal, "client"));
        assertFalse(MoaSurfaceProgramEvents.timestamp(proposal.issuedAtMs).equals(durableStarted));
    }

    @Test public void trimNeverEvictsUnacknowledgedRecords() throws Exception {
        JSONArray entries = new JSONArray();
        for (int i = 0; i < 81; i++) {
            JSONObject event = new JSONObject().put("kind", "accepted").put("payload", new JSONObject());
            entries.put(new JSONObject().put("execution_id", "unacked_" + i).put("idempotency_key", "idem_" + i)
                    .put("request_id", "request_" + i).put("events", new JSONArray().put(event))
                    .put("sync", new JSONObject().put("event_index", 0).put("prerequisite_acked", false)));
        }
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().putString("entries", entries.toString()).commit();
        assertTrue(store.recordPending(proposal, "client", "request_new"));
        JSONArray persisted = new JSONArray(context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).getString("entries", "[]"));
        assertEquals(82, persisted.length());
        assertNotNull(store.existing("unacked_0", "none"));
    }

    @Test public void malformedAndIncompleteOutboxStateFailsClosed() throws Exception {
        JSONObject noRequest = entry("no_request").put("events", new JSONArray().put(event("accepted")));
        JSONObject noEvents = entry("no_events").put("request_id", "request");
        JSONObject negative = entry("negative").put("request_id", "request").put("events", new JSONArray().put(event("accepted")))
                .put("sync", sync(-1, false));
        JSONObject past = entry("past").put("request_id", "request").put("events", new JSONArray().put(event("accepted")))
                .put("sync", sync(1, false));
        JSONObject nullEvent = entry("null_event").put("request_id", "request").put("events", new JSONArray().put(JSONObject.NULL));
        putEntries(new JSONArray().put("not-an-object").put(noRequest).put(noEvents).put(negative).put(past).put(nullEvent));
        assertEquals(0, store.pendingSyncEntries().length());
        assertNull(store.nextSyncDelivery("missing"));
        assertNull(store.nextSyncDelivery("no_request"));
        assertNull(store.nextSyncDelivery("no_events"));
        assertNull(store.nextSyncDelivery("negative"));
        assertNull(store.nextSyncDelivery("past"));
        assertNull(store.nextSyncDelivery("null_event"));
        assertFalse(store.acknowledgeSyncDelivery("missing", "event:0"));
        assertFalse(store.acknowledgeSyncDelivery("no_events", "event:0"));

        JSONObject missingToolPayload = entry("tool_missing_payload").put("request_id", "request")
                .put("events", new JSONArray().put(new JSONObject().put("kind", "tool_finished")));
        JSONObject missingReceipts = entry("tool_missing_receipts").put("request_id", "request")
                .put("events", new JSONArray().put(event("tool_finished").put("payload", new JSONObject().put("receipt_id", "wanted"))));
        JSONObject mismatchedReceipts = entry("tool_mismatch").put("request_id", "request")
                .put("events", new JSONArray().put(event("tool_finished").put("payload", new JSONObject().put("receipt_id", "wanted"))))
                .put("tool_receipts", new JSONArray().put(JSONObject.NULL).put(new JSONObject().put("receipt_id", "other")));
        JSONObject missingTerminal = entry("terminal_missing").put("request_id", "request")
                .put("events", new JSONArray().put(event("terminal")));
        putEntries(new JSONArray().put(missingToolPayload).put(missingReceipts).put(mismatchedReceipts).put(missingTerminal));
        assertNull(store.nextSyncDelivery("tool_missing_payload"));
        assertNull(store.nextSyncDelivery("tool_missing_receipts"));
        assertNull(store.nextSyncDelivery("tool_mismatch"));
        assertNull(store.nextSyncDelivery("terminal_missing"));

        JSONObject alreadyAckedTool = entry("tool_acked").put("request_id", "request")
                .put("events", new JSONArray().put(event("tool_finished"))).put("sync", sync(0, true));
        putEntries(new JSONArray().put(alreadyAckedTool));
        assertEquals("event", store.nextSyncDelivery("tool_acked").optString("kind"));
    }

    @Test public void migrationAndTrimmingBranchesPreserveDeliveryAuthority() throws Exception {
        assertFalse(store.hasPendingAttempt(null));
        JSONObject noMarkers = new JSONObject();
        assertFalse(store.hasPendingAttempt(noMarkers));
        JSONObject legacy = new JSONObject().put("pending_effects", new JSONArray().put(new JSONObject()));
        assertTrue(store.hasPendingAttempt(legacy));
        JSONObject current = new JSONObject().put("pending_attempts", new JSONArray());
        assertFalse(store.hasPendingAttempt(current));

        trimSeed(new JSONArray().put(JSONObject.NULL), 80);
        trimSeed(new JSONArray().put(entry("no_request")), 80);
        trimSeed(new JSONArray().put(entry("complete").put("request_id", "request").put("events", new JSONArray()).put("sync", sync(0, false))), 80);

        assertFalse(store.bindRequest(proposal.executionId, proposal.idempotencyKey, null));
        putEntries(new JSONArray().put(JSONObject.NULL).put(entry("other").put("idempotency_key", "other_idem")));
        assertFalse(store.bindRequest("missing", "missing", "request"));
    }

    @Test public void recoveryFallsBackWhenDurableStartedEventIsMissingOrMalformed() throws Exception {
        JSONObject marker = new JSONObject().put("tool_call_id", "read_crash").put("capability_id", MoaScriptExecutionCatalog.OBSERVE)
                .put("input_sha256", "2".repeat(64)).put("attempt", 1).put("started_at", MoaSurfaceProgramEvents.timestamp(10));
        JSONObject pending = entry(proposal.executionId).put("idempotency_key", proposal.idempotencyKey).put("status", "pending")
                .put("pending_attempts", new JSONArray().put(marker));
        putEntries(new JSONArray().put(pending));
        assertNotNull(store.recoverIndeterminate(proposal, "client"));
        assertEquals(MoaSurfaceProgramEvents.timestamp(proposal.issuedAtMs),
                store.existing(proposal.executionId, proposal.idempotencyKey).getJSONObject("terminal").getString("started_at"));

        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        JSONObject prior = MoaSurfaceProgramReceipts.toolBound(proposal, "client", "prior", 1, MoaScriptExecutionCatalog.CLICK,
                new JSONObject(), "succeeded", "", proposal.observationDigest, "3".repeat(64), 8, 9);
        pending = entry(proposal.executionId).put("idempotency_key", proposal.idempotencyKey).put("status", "pending")
                .put("events", new JSONArray()).put("tool_receipts", new JSONArray().put(prior))
                .put("pending_attempts", new JSONArray().put(marker));
        putEntries(new JSONArray().put(pending));
        assertNotNull(store.recoverIndeterminate(proposal, "client"));
        assertEquals("3".repeat(64), store.existing(proposal.executionId, proposal.idempotencyKey)
                .getJSONArray("tool_receipts").getJSONObject(1).getString("pre_state_sha256"));

        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
        assertTrue(store.recordPending(proposal, "client"));
        assertTrue(store.beginTool(proposal, "client", "read_crash", MoaScriptExecutionCatalog.OBSERVE, "2".repeat(64), false, 10));
        JSONArray entries = persisted();
        entries.getJSONObject(0).getJSONArray("events").getJSONObject(1).put("occurred_at", "malformed");
        putEntries(entries);
        assertNotNull(store.recoverIndeterminate(proposal, "client"));
        assertEquals(MoaSurfaceProgramEvents.timestamp(proposal.issuedAtMs),
                store.existing(proposal.executionId, proposal.idempotencyKey).getJSONObject("terminal").getString("started_at"));
    }

    private void assertDelivery(String id, String kind) {
        JSONObject delivery = store.nextSyncDelivery(proposal.executionId);
        assertNotNull(delivery);
        assertEquals(id, delivery.optString("delivery_id"));
        assertEquals(kind, delivery.optString("kind"));
        assertTrue(store.acknowledgeSyncDelivery(proposal.executionId, id));
    }

    private JSONObject entry(String executionId) throws Exception {
        return new JSONObject().put("execution_id", executionId).put("idempotency_key", "idem_" + executionId);
    }

    private JSONObject event(String kind) throws Exception {
        return new JSONObject().put("kind", kind).put("payload", new JSONObject());
    }

    private JSONObject sync(int eventIndex, boolean prerequisiteAcked) throws Exception {
        return new JSONObject().put("event_index", eventIndex).put("prerequisite_acked", prerequisiteAcked);
    }

    private void trimSeed(JSONArray prefix, int expectedLength) throws Exception {
        for (int i = prefix.length(); i < 81; i++) prefix.put(entry("old_" + i));
        putEntries(prefix);
        assertTrue(store.recordPending(proposal));
        assertEquals(expectedLength, persisted().length());
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().clear().commit();
    }

    private JSONArray persisted() throws Exception {
        return new JSONArray(context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).getString("entries", "[]"));
    }

    private void putEntries(JSONArray entries) {
        context.getSharedPreferences("moa_surface_programs_v1", Context.MODE_PRIVATE).edit().putString("entries", entries.toString()).commit();
    }
}
