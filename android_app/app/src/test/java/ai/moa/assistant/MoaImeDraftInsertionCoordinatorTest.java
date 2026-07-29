package ai.moa.assistant;

import android.text.InputType;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaImeDraftInsertionCoordinatorTest {
    private static final long NOW = 2_000L;

    @Test
    public void servicePathExecutesExactVisibleCandidateAndReturnsTerminalReceipt() {
        Fixture fixture = new Fixture();
        MoaEditorSensitivityPolicy.EditorIdentity editor = editor("pkg", 4, "body",
                InputType.TYPE_CLASS_TEXT);
        MoaEditorSessionBinding.SessionToken session = fixture.binding.beginEditor(editor);
        fixture.binding.stageCandidate(session, "  exact text  ");
        AtomicInteger calls = new AtomicInteger();
        AtomicReference<String> inserted = new AtomicReference<>();

        MoaDraftInsertionPolicy.Receipt receipt = fixture.coordinator.attemptInsert(
                "attempt-1", session, editor, NOW, text -> {
                    calls.incrementAndGet();
                    inserted.set(text);
                    return true;
                });

        assertTrue(receipt.succeeded());
        assertEquals("  exact text  ", inserted.get());
        assertEquals(1, calls.get());
        assertEquals("pkg", receipt.targetPackage);
        assertEquals(64, receipt.targetFingerprint.length());
        assertEquals(64, receipt.proposedTextSha256.length());
    }

    @Test
    public void changedEditorProducesBoundTerminalReceiptAndZeroMutation() {
        Fixture fixture = new Fixture();
        MoaEditorSensitivityPolicy.EditorIdentity first = editor("pkg", 4, "body",
                InputType.TYPE_CLASS_TEXT);
        MoaEditorSessionBinding.SessionToken session = fixture.binding.beginEditor(first);
        fixture.binding.stageCandidate(session, "draft from screen");
        AtomicInteger calls = new AtomicInteger();

        MoaDraftInsertionPolicy.Receipt receipt = fixture.coordinator.attemptInsert(
                "stale", session,
                editor("pkg", 5, "subject", InputType.TYPE_CLASS_TEXT),
                NOW,
                text -> {
                    calls.incrementAndGet();
                    return true;
                });

        assertFalse(receipt.succeeded());
        assertEquals(MoaDraftInsertionPolicy.Status.REFUSED, receipt.status);
        assertEquals(MoaDraftInsertionPolicy.Reason.TARGET_MISMATCH, receipt.reason);
        assertEquals("pkg", receipt.targetPackage);
        assertEquals(64, receipt.targetFingerprint.length());
        assertEquals(64, receipt.proposedTextSha256.length());
        assertEquals(0, calls.get());
        assertEquals(
                MoaDraftInsertionPolicy.Reason.REPLAYED,
                fixture.coordinator.attemptInsert("stale", session, first, NOW, text -> true).reason
        );
    }

    @Test
    public void sensitiveNoCandidateAndFinishedEditorAllReceiptWithoutMutation() {
        AtomicInteger calls = new AtomicInteger();

        Fixture sensitiveFixture = new Fixture();
        MoaEditorSensitivityPolicy.EditorIdentity password = editor(
                "pkg", 9, "password",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        MoaEditorSessionBinding.SessionToken passwordSession =
                sensitiveFixture.binding.beginEditor(password);
        MoaDraftInsertionPolicy.Receipt sensitive = sensitiveFixture.coordinator.attemptInsert(
                "sensitive", passwordSession, password, NOW, text -> {
                    calls.incrementAndGet();
                    return true;
                });
        assertEquals(MoaDraftInsertionPolicy.Reason.SENSITIVE_TARGET, sensitive.reason);
        assertEquals("pkg", sensitive.targetPackage);
        assertEquals(64, sensitive.targetFingerprint.length());
        assertEquals(64, sensitive.proposedTextSha256.length());

        Fixture emptyFixture = new Fixture();
        MoaEditorSensitivityPolicy.EditorIdentity ordinary = editor(
                "pkg", 2, "body", InputType.TYPE_CLASS_TEXT);
        MoaEditorSessionBinding.SessionToken emptySession = emptyFixture.binding.beginEditor(ordinary);
        MoaDraftInsertionPolicy.Receipt empty = emptyFixture.coordinator.attemptInsert(
                "empty", emptySession, ordinary, NOW, text -> {
                    calls.incrementAndGet();
                    return true;
                });
        assertEquals(MoaDraftInsertionPolicy.Reason.NO_CANDIDATE, empty.reason);

        Fixture finishedFixture = new Fixture();
        MoaEditorSessionBinding.SessionToken finishedSession =
                finishedFixture.binding.beginEditor(ordinary);
        finishedFixture.binding.stageCandidate(finishedSession, "cleared on finish");
        finishedFixture.binding.finishEditor();
        MoaDraftInsertionPolicy.Receipt finished = finishedFixture.coordinator.attemptInsert(
                "finished", finishedSession, ordinary, NOW, text -> {
                    calls.incrementAndGet();
                    return true;
                });
        assertEquals(MoaDraftInsertionPolicy.Reason.NO_ACTIVE_EDITOR, finished.reason);
        assertEquals("pkg", finished.targetPackage);
        assertEquals(0, calls.get());
    }

    @Test
    public void nullSessionAndNullObservedEditorStillYieldTerminalReceipt() {
        Fixture fixture = new Fixture();
        AtomicInteger calls = new AtomicInteger();
        MoaDraftInsertionPolicy.Receipt receipt = fixture.coordinator.attemptInsert(
                "missing", null, null, NOW, text -> {
                    calls.incrementAndGet();
                    return true;
                });
        assertEquals(MoaDraftInsertionPolicy.Reason.NO_ACTIVE_EDITOR, receipt.reason);
        assertEquals(MoaDraftInsertionPolicy.Status.REFUSED, receipt.status);
        assertEquals(64, receipt.proposedTextSha256.length());
        assertEquals(0, calls.get());
    }

    private static final class Fixture {
        final MoaEditorSessionBinding binding = new MoaEditorSessionBinding();
        final MoaImeDraftInsertionCoordinator coordinator = new MoaImeDraftInsertionCoordinator(
                binding, new MoaDraftInsertionPolicy.Controller());
    }

    private static MoaEditorSensitivityPolicy.EditorIdentity editor(
            String packageName,
            int fieldId,
            String fieldName,
            int inputType
    ) {
        return new MoaEditorSensitivityPolicy.EditorIdentity(
                packageName, fieldId, inputType, 0, fieldName, "Message", "");
    }
}
