package ai.moa.assistant;

import android.text.InputType;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

public final class MoaActionReceiptStoreTest {
    @Test
    public void draftReceiptPersistsBoundMetadataAndExtendsHashChain() throws Exception {
        MemoryBackend backend = new MemoryBackend();
        MoaDraftInsertionPolicy.Receipt firstDraft = executed("one", "first text");
        MoaActionReceiptStore.WriteResult first =
                MoaActionReceiptStore.recordDraftInsertion(firstDraft, backend, 10L);

        assertTrue(first.persisted);
        assertEquals("screen.insert_text", first.receipt.getString("tool"));
        assertEquals("communication_draft", first.receipt.getString("risk"));
        assertEquals("explicit_local_approval", first.receipt.getString("approval"));
        assertEquals("pkg", first.receipt.getString("target"));
        assertTrue(first.receipt.getBoolean("success"));
        assertEquals(10L, first.receipt.getLong("timestamp_ms"));
        assertEquals("", first.receipt.getString("previous_hash"));
        assertEquals(64, first.receipt.getString("hash").length());
        JSONObject details = first.receipt.getJSONObject("details");
        assertEquals("one", details.getString("proposal_id"));
        assertEquals("pkg", details.getString("target_package"));
        assertEquals(64, details.getString("target_fingerprint").length());
        assertEquals(64, details.getString("proposed_text_sha256").length());
        assertFalse(details.getString("proposed_text_sha256").contains("first text"));
        assertEquals("ime_commit_text", details.getString("effect"));
        assertEquals("executed", details.getString("status"));
        assertEquals("none", details.getString("reason"));

        MoaActionReceiptStore.WriteResult second = MoaActionReceiptStore.recordDraftInsertion(
                executed("two", "second text"), backend, 11L);
        assertTrue(second.persisted);
        assertEquals(first.receipt.getString("hash"), second.receipt.getString("previous_hash"));
        assertNotEquals(first.receipt.getString("hash"), second.receipt.getString("hash"));
        JSONArray stored = new JSONArray(backend.receiptsJson);
        assertEquals(2, stored.length());
        assertEquals(second.receipt.getString("hash"), backend.lastHash);
    }

    @Test
    public void refusalMetadataPersistsWithoutProposedText() throws Exception {
        MemoryBackend backend = new MemoryBackend();
        MoaDraftInsertionPolicy.Receipt refusal = refused("stale", "private draft");
        MoaActionReceiptStore.WriteResult result =
                MoaActionReceiptStore.recordDraftInsertion(refusal, backend, 12L);

        assertTrue(result.persisted);
        assertFalse(result.receipt.getBoolean("success"));
        JSONObject details = result.receipt.getJSONObject("details");
        assertEquals("refused", details.getString("status"));
        assertEquals("target_mismatch", details.getString("reason"));
        assertFalse(result.receipt.toString().contains("private draft"));
    }

    @Test
    public void persistenceFailureReturnsCompleteTerminalReceiptAndDoesNotAdvanceBackend() throws Exception {
        MemoryBackend backend = new MemoryBackend();
        backend.throwOnWrite = true;
        MoaActionReceiptStore.WriteResult result = MoaActionReceiptStore.recordDraftInsertion(
                refused("failure", "must not leak"), backend, 13L);

        assertFalse(result.persisted);
        assertEquals("failure", result.receipt.getJSONObject("details").getString("proposal_id"));
        assertEquals(64, result.receipt.getString("hash").length());
        assertEquals("[]", backend.receiptsJson);
        assertEquals("", backend.lastHash);

        MoaActionReceiptStore.WriteResult missingBackend =
                MoaActionReceiptStore.recordDraftInsertion(null, null, 14L);
        assertFalse(missingBackend.persisted);
        assertEquals("invalid_proposal",
                missingBackend.receipt.getJSONObject("details").getString("reason"));
    }

    @Test
    public void malformedPriorReceiptsFailClosedToFreshBoundedChain() throws Exception {
        MemoryBackend backend = new MemoryBackend();
        backend.receiptsJson = "not-json";
        backend.lastHash = "prior-hash";
        MoaActionReceiptStore.WriteResult result = MoaActionReceiptStore.recordDraftInsertion(
                executed("repair", "text"), backend, 15L);

        assertTrue(result.persisted);
        assertEquals("prior-hash", result.receipt.getString("previous_hash"));
        assertEquals(1, new JSONArray(backend.receiptsJson).length());
    }

    private static MoaDraftInsertionPolicy.Receipt executed(String proposalId, String text) {
        return receipt(proposalId, text, false);
    }

    private static MoaDraftInsertionPolicy.Receipt refused(String proposalId, String text) {
        return receipt(proposalId, text, true);
    }

    private static MoaDraftInsertionPolicy.Receipt receipt(
            String proposalId,
            String text,
            boolean stale
    ) {
        MoaEditorSensitivityPolicy.EditorIdentity editor = new MoaEditorSensitivityPolicy.EditorIdentity(
                "pkg", 1, InputType.TYPE_CLASS_TEXT, 0, "body", "Message", "");
        MoaDraftInsertionPolicy.EditableTarget target =
                MoaDraftInsertionPolicy.EditableTarget.fromEditor(editor, 100L);
        MoaDraftInsertionPolicy.Proposal proposal = MoaDraftInsertionPolicy.Proposal.insert(
                proposalId, text, target, 100L);
        MoaDraftInsertionPolicy.Approval approval =
                MoaDraftInsertionPolicy.Approval.explicitLocal(proposal, 100L);
        if (stale) {
            MoaEditorSensitivityPolicy.EditorIdentity changed =
                    new MoaEditorSensitivityPolicy.EditorIdentity(
                            "pkg", 2, InputType.TYPE_CLASS_TEXT, 0,
                            "subject", "Subject", "");
            return new MoaDraftInsertionPolicy.Controller().execute(
                    proposal,
                    approval,
                    MoaDraftInsertionPolicy.EditableTarget.fromEditor(changed, 100L),
                    100L,
                    exact -> true
            );
        }
        return new MoaDraftInsertionPolicy.Controller().execute(
                proposal, approval, target, 100L, exact -> true);
    }

    private static final class MemoryBackend implements MoaActionReceiptStore.ReceiptBackend {
        String receiptsJson = "[]";
        String lastHash = "";
        boolean throwOnWrite;

        @Override
        public String receiptsJson() {
            return receiptsJson;
        }

        @Override
        public String lastHash() {
            return lastHash;
        }

        @Override
        public boolean write(String receiptsJson, String lastHash) {
            if (throwOnWrite) {
                throw new IllegalStateException("disk unavailable");
            }
            this.receiptsJson = receiptsJson;
            this.lastHash = lastHash;
            return true;
        }
    }
}
