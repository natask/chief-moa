package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicLong;

public class MoaToolReceiptOutboxTest {
    private static final String CLAIM = "claim_123";
    @Test
    public void pendingReceiptSurvivesRestartAndRetriesExactBody() throws Exception {
        MemoryState state = new MemoryState();
        MoaToolReceiptOutbox first = outbox(state);
        MoaToolReceiptOutbox.Reservation reservation = first.reserve("toolreq_1", CLAIM, "android_1");
        assertTrue(reservation.mayExecute());

        MoaToolReceiptOutbox.Completion completion = first.complete(
                reservation, "media.open", true, "Opened video.", localReceipt("media.open", true));
        assertTrue(completion.readyToSend());
        String originalBody = completion.pending.bodyJson;
        String originalDigest = completion.pending.bodyDigest;

        MoaToolReceiptOutbox restarted = outbox(state);
        MoaToolReceiptOutbox.Snapshot snapshot = restarted.snapshot();
        assertTrue(snapshot.healthy);
        assertEquals(1, snapshot.pending.size());
        assertEquals(originalBody, snapshot.pending.get(0).bodyJson);
        assertEquals(originalDigest, snapshot.pending.get(0).bodyDigest);
        assertEquals(CLAIM, snapshot.pending.get(0).claimId);
        assertEquals(CLAIM, snapshot.pending.get(0).body().getString("claim_id"));

        MoaToolReceiptOutbox.Reservation replay = restarted.reserve("toolreq_1", CLAIM, "android_1");
        assertEquals(MoaToolReceiptOutbox.ReservationStatus.RETRY_PENDING, replay.status);
        assertFalse(replay.mayExecute());
        assertEquals(reservation.receiptId, replay.receiptId);
    }

    @Test
    public void truthfulMediaOutcomeSurvivesRetryWithoutReexecution() throws Exception {
        MemoryState state = new MemoryState();
        MoaToolReceiptOutbox first = outbox(state);
        MoaToolReceiptOutbox.Reservation reservation = first.reserve("toolreq_truth", CLAIM, "android_1");
        JSONObject local = localReceipt("media.open", false).put("outcome", "selection_unverified");
        MoaToolReceiptOutbox.Completion completion = first.complete(
                reservation, "media.open", false,
                "Selected app opened; playback was not verified.", local);

        MoaToolReceiptOutbox restarted = outbox(state);
        MoaToolReceiptOutbox.PendingReceipt pending = restarted.snapshot().pending.get(0);
        assertEquals(completion.pending.bodyJson, pending.bodyJson);
        assertEquals("selection_unverified",
                pending.body().getJSONObject("local_receipt").getString("outcome"));
        assertEquals(MoaToolReceiptOutbox.ReservationStatus.RETRY_PENDING,
                restarted.reserve("toolreq_truth", CLAIM, "android_1").status);
    }

    @Test
    public void capacityRejectsBeforeActionWithoutEvictingUnresolvedEvidence() {
        MemoryState state = new MemoryState();
        MoaToolReceiptOutbox outbox = outbox(state);
        for (int index = 0; index < MoaToolReceiptOutbox.MAX_PENDING_RECORDS; index++) {
            assertTrue(outbox.reserve("request_" + index, CLAIM, "android_1").mayExecute());
        }
        String before = state.encoded;

        MoaToolReceiptOutbox.Reservation rejected = outbox.reserve("request_overflow", CLAIM, "android_1");
        assertEquals(MoaToolReceiptOutbox.ReservationStatus.CAPACITY, rejected.status);
        assertFalse(rejected.mayExecute());
        assertEquals(before, state.encoded);
        assertEquals(MoaToolReceiptOutbox.MAX_PENDING_RECORDS,
                outbox.snapshot().uncertainReservations.size());
    }

    @Test
    public void corruptStateFailsClosedAndRemainsUntouched() {
        MemoryState state = new MemoryState();
        state.encoded = "{not valid";
        MoaToolReceiptOutbox outbox = outbox(state);

        MoaToolReceiptOutbox.Reservation result = outbox.reserve("request_1", CLAIM, "android_1");
        assertEquals(MoaToolReceiptOutbox.ReservationStatus.CORRUPT, result.status);
        assertFalse(result.mayExecute());
        assertFalse(outbox.snapshot().healthy);
        assertEquals("{not valid", state.encoded);
    }

    @Test
    public void failedReservationWriteNeverAuthorizesExecution() {
        MemoryState state = new MemoryState();
        state.failWrites = true;
        MoaToolReceiptOutbox.Reservation result = outbox(state)
                .reserve("request_1", CLAIM, "android_1");

        assertEquals(MoaToolReceiptOutbox.ReservationStatus.DURABILITY_FAILED, result.status);
        assertFalse(result.mayExecute());
        assertEquals("", state.encoded);
    }

    @Test
    public void failedCompletionWriteLeavesReservationUnsendable() throws Exception {
        MemoryState state = new MemoryState();
        MoaToolReceiptOutbox outbox = outbox(state);
        MoaToolReceiptOutbox.Reservation reservation = outbox.reserve("request_1", CLAIM, "android_1");
        state.failWrites = true;

        MoaToolReceiptOutbox.Completion completion = outbox.complete(
                reservation, "media.control", true, "Paused.", localReceipt("media.control", true));
        assertEquals(MoaToolReceiptOutbox.CompletionStatus.DURABILITY_FAILED, completion.status);
        assertFalse(completion.readyToSend());
        assertEquals(0, outbox.snapshot().pending.size());
        assertEquals(1, outbox.snapshot().uncertainReservations.size());
    }

    @Test
    public void acknowledgementMustMatchAndBeAcceptedBeforeRemoval() throws Exception {
        MemoryState state = new MemoryState();
        MoaToolReceiptOutbox outbox = outbox(state);
        MoaToolReceiptOutbox.PendingReceipt pending = pending(outbox, "request_1");

        assertEquals(MoaToolReceiptOutbox.AckResult.NOT_ACCEPTED,
                outbox.acknowledge(pending, MoaToolReceiptOutbox.Acknowledgement.rejected()));
        assertEquals(MoaToolReceiptOutbox.AckResult.MISMATCH,
                outbox.acknowledge(pending, MoaToolReceiptOutbox.Acknowledgement.accepted(
                        pending.requestId, pending.receiptId, "0".repeat(64), false)));
        assertEquals(1, outbox.snapshot().pending.size());

        MoaToolReceiptOutbox.Acknowledgement accepted =
                MoaToolReceiptOutbox.Acknowledgement.accepted(
                        pending.requestId, pending.receiptId, pending.bodyDigest, true);
        assertEquals(MoaToolReceiptOutbox.AckResult.REMOVED,
                outbox.acknowledge(pending, accepted));
        assertEquals(0, outbox.snapshot().pending.size());
    }

    @Test
    public void failedAcknowledgementPersistenceKeepsPendingReceipt() throws Exception {
        MemoryState state = new MemoryState();
        MoaToolReceiptOutbox outbox = outbox(state);
        MoaToolReceiptOutbox.PendingReceipt pending = pending(outbox, "request_1");
        state.failWrites = true;

        MoaToolReceiptOutbox.Acknowledgement accepted =
                MoaToolReceiptOutbox.Acknowledgement.accepted(
                        pending.requestId, pending.receiptId, pending.bodyDigest, false);
        assertEquals(MoaToolReceiptOutbox.AckResult.DURABILITY_FAILED,
                outbox.acknowledge(pending, accepted));
        assertEquals(1, outbox.snapshot().pending.size());
    }

    @Test
    public void currentGatewayEchoProducesBoundAcknowledgement() throws Exception {
        MemoryState state = new MemoryState();
        MoaToolReceiptOutbox outbox = outbox(state);
        MoaToolReceiptOutbox.PendingReceipt pending = pending(outbox, "request_1");
        JSONObject gatewayResponse = new JSONObject().put("receipt", new JSONObject()
                .put("id", "gateway_receipt_1")
                .put("ok", true)
                .put("local_receipt", pending.body().getJSONObject("local_receipt")));

        MoaToolReceiptOutbox.Acknowledgement acknowledgement =
                MoaToolReceiptOutbox.gatewayAcknowledgement(pending, gatewayResponse);
        assertTrue(acknowledgement.accepted);
        assertEquals(MoaToolReceiptOutbox.AckResult.REMOVED,
                outbox.acknowledge(pending, acknowledgement));
    }

    @Test
    public void mismatchedGatewayEchoCannotAcknowledgeDifferentEnvelope() throws Exception {
        MemoryState state = new MemoryState();
        MoaToolReceiptOutbox outbox = outbox(state);
        MoaToolReceiptOutbox.PendingReceipt pending = pending(outbox, "request_1");
        JSONObject local = pending.body().getJSONObject("local_receipt");
        local.put("receipt_id", "receipt_other");
        JSONObject gatewayResponse = new JSONObject().put("receipt", new JSONObject()
                .put("local_receipt", local));

        assertFalse(MoaToolReceiptOutbox.gatewayAcknowledgement(pending, gatewayResponse).accepted);
        assertEquals(1, outbox.snapshot().pending.size());
    }

    @Test
    public void durableEnvelopeRedactsSecretsAndExcludesRawLocalTarget() throws Exception {
        MemoryState state = new MemoryState();
        MoaToolReceiptOutbox outbox = outbox(state);
        MoaToolReceiptOutbox.Reservation reservation = outbox.reserve("request_1", CLAIM, "android_1");
        JSONObject local = localReceipt("url.open", false)
                .put("target", "https://example.test/?access_token=raw-query-secret")
                .put("result", "Bearer raw-bearer-secret");
        String summary = "Failed key=AIza123456789012345678901234567890 and token=raw-summary-secret";

        MoaToolReceiptOutbox.Completion completion = outbox.complete(
                reservation, "url.open", false, summary, local);
        assertTrue(completion.readyToSend());
        assertFalse(state.encoded.contains("raw-query-secret"));
        assertFalse(state.encoded.contains("raw-bearer-secret"));
        assertFalse(state.encoded.contains("raw-summary-secret"));
        assertFalse(state.encoded.contains("AIza123456789012345678901234567890"));
        assertTrue(completion.pending.bodyJson.contains("[redacted]"));
        assertFalse(completion.pending.body().getJSONObject("local_receipt").has("target"));
        assertFalse(completion.pending.body().getJSONObject("local_receipt").has("result"));
    }

    @Test
    public void conflictingTerminalBodyCannotReplacePendingReceipt() throws Exception {
        MemoryState state = new MemoryState();
        MoaToolReceiptOutbox outbox = outbox(state);
        MoaToolReceiptOutbox.Reservation reservation = outbox.reserve("request_1", CLAIM, "android_1");
        MoaToolReceiptOutbox.Completion first = outbox.complete(
                reservation, "media.open", true, "Opened.", localReceipt("media.open", true));
        String persisted = state.encoded;

        MoaToolReceiptOutbox.Completion conflicting = outbox.complete(
                reservation, "media.open", false, "Failed.", localReceipt("media.open", false));
        assertEquals(MoaToolReceiptOutbox.CompletionStatus.COLLISION, conflicting.status);
        assertEquals(persisted, state.encoded);
        assertEquals(first.pending.bodyDigest, outbox.snapshot().pending.get(0).bodyDigest);
    }

    @Test
    public void strictIdentifiersAndDeviceBindingFailClosed() {
        MemoryState state = new MemoryState();
        MoaToolReceiptOutbox outbox = outbox(state);
        assertEquals(MoaToolReceiptOutbox.ReservationStatus.INVALID,
                outbox.reserve("bad/id", CLAIM, "android_1").status);
        MoaToolReceiptOutbox.Reservation first = outbox.reserve("request_1", CLAIM, "android_1");
        assertTrue(first.mayExecute());
        assertEquals(MoaToolReceiptOutbox.ReservationStatus.COLLISION,
                outbox.reserve("request_1", CLAIM, "android_2").status);
        assertEquals(MoaToolReceiptOutbox.ReservationStatus.COLLISION,
                outbox.reserve("request_1", "claim_other", "android_1").status);
        assertNotEquals("", first.receiptId);
    }

    @Test
    public void bodyTamperingMakesWholeStoreCorruptWithoutDeletingBytes() throws Exception {
        MemoryState state = new MemoryState();
        MoaToolReceiptOutbox outbox = outbox(state);
        pending(outbox, "request_1");
        String original = state.encoded;
        state.encoded = original.replace("Completed.", "Tampered.");
        String tampered = state.encoded;

        assertFalse(outbox.snapshot().healthy);
        assertEquals(MoaToolReceiptOutbox.ReservationStatus.CORRUPT,
                outbox.reserve("request_2", CLAIM, "android_1").status);
        assertEquals(tampered, state.encoded);
    }

    private static MoaToolReceiptOutbox.PendingReceipt pending(
            MoaToolReceiptOutbox outbox, String requestId) throws Exception {
        MoaToolReceiptOutbox.Reservation reservation = outbox.reserve(requestId, CLAIM, "android_1");
        return outbox.complete(reservation, "media.open", true, "Completed.",
                localReceipt("media.open", true)).pending;
    }

    private static JSONObject localReceipt(String tool, boolean success) throws Exception {
        return new JSONObject()
                .put("tool", tool)
                .put("risk", "local_navigation")
                .put("approval", "implicit_user_command")
                .put("target", "sensitive-target-not-projected")
                .put("success", success)
                .put("result", "sensitive-result-not-projected")
                .put("timestamp_ms", 1234L)
                .put("hash", "a".repeat(64));
    }

    private static MoaToolReceiptOutbox outbox(MemoryState state) {
        AtomicLong now = new AtomicLong(1000L);
        return new MoaToolReceiptOutbox(state, now::getAndIncrement);
    }

    private static final class MemoryState implements MoaToolReceiptOutbox.DurableState {
        String encoded = "";
        boolean failWrites;

        @Override public String read() {
            return encoded;
        }

        @Override public boolean write(String next) {
            if (failWrites) return false;
            encoded = next;
            return true;
        }
    }
}
