package ai.moa.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.text.InputType;

import org.junit.Test;

public final class MoaEditorSessionBindingTest {
    @Test
    public void exactCandidateIsReturnedWithoutTrimmingOrSubmitSemantics() {
        MoaEditorSessionBinding binding = new MoaEditorSessionBinding();
        MoaEditorSensitivityPolicy.EditorIdentity editor = editor("pkg", 1, InputType.TYPE_CLASS_TEXT);
        MoaEditorSessionBinding.SessionToken session = binding.beginEditor(editor);

        assertFalse(binding.isSensitive(session));
        assertEquals(
                MoaEditorSessionBinding.Rejection.NONE,
                binding.stageCandidate(session, "  Exact text.  ")
        );
        assertEquals("  Exact text.  ", binding.visibleCandidate(session));

        MoaEditorSessionBinding.CommitDecision decision = binding.authorizeCommit(session, editor);
        assertTrue(decision.allowed);
        assertEquals("  Exact text.  ", decision.exactText);
        assertEquals(MoaEditorSessionBinding.Rejection.NONE, decision.rejection);
    }

    @Test
    public void sensitiveEditorCannotStageDisplayOrCommit() {
        MoaEditorSessionBinding binding = new MoaEditorSessionBinding();
        MoaEditorSensitivityPolicy.EditorIdentity password = editor(
                "pkg", 1, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        MoaEditorSessionBinding.SessionToken session = binding.beginEditor(password);

        assertTrue(binding.isSensitive(session));
        assertEquals(
                MoaEditorSessionBinding.Rejection.SENSITIVE_EDITOR,
                binding.stageCandidate(session, "must not persist")
        );
        assertNull(binding.visibleCandidate(session));
        assertRejected(
                binding.authorizeCommit(session, password),
                MoaEditorSessionBinding.Rejection.SENSITIVE_EDITOR
        );
    }

    @Test
    public void editorGenerationAndIdentityChangesInvalidateCandidate() {
        MoaEditorSessionBinding binding = new MoaEditorSessionBinding();
        MoaEditorSensitivityPolicy.EditorIdentity first = editor("pkg", 1, InputType.TYPE_CLASS_TEXT);
        MoaEditorSessionBinding.SessionToken firstSession = binding.beginEditor(first);
        binding.stageCandidate(firstSession, "first");

        MoaEditorSensitivityPolicy.EditorIdentity second = editor("pkg", 2, InputType.TYPE_CLASS_TEXT);
        assertRejected(
                binding.authorizeCommit(firstSession, second),
                MoaEditorSessionBinding.Rejection.STALE_EDITOR
        );

        MoaEditorSessionBinding.SessionToken secondSession = binding.beginEditor(second);
        assertNull(binding.visibleCandidate(secondSession));
        assertRejected(
                binding.authorizeCommit(firstSession, first),
                MoaEditorSessionBinding.Rejection.STALE_EDITOR
        );
        assertRejected(
                binding.authorizeCommit(secondSession, first),
                MoaEditorSessionBinding.Rejection.STALE_EDITOR
        );
        assertRejected(
                binding.authorizeCommit(secondSession, second),
                MoaEditorSessionBinding.Rejection.NO_CANDIDATE
        );
    }

    @Test
    public void emptyCandidateAndExplicitClearLeaveNoCandidate() {
        MoaEditorSessionBinding binding = new MoaEditorSessionBinding();
        MoaEditorSensitivityPolicy.EditorIdentity editor = editor("pkg", 1, InputType.TYPE_CLASS_TEXT);
        MoaEditorSessionBinding.SessionToken session = binding.beginEditor(editor);

        assertEquals(
                MoaEditorSessionBinding.Rejection.EMPTY_CANDIDATE,
                binding.stageCandidate(session, null)
        );
        assertEquals(
                MoaEditorSessionBinding.Rejection.EMPTY_CANDIDATE,
                binding.stageCandidate(session, "")
        );
        binding.stageCandidate(session, "candidate");
        binding.clearCandidate();
        assertNull(binding.visibleCandidate(session));
        assertRejected(
                binding.authorizeCommit(session, editor),
                MoaEditorSessionBinding.Rejection.NO_CANDIDATE
        );
    }

    @Test
    public void finishAndMissingSessionFailClosed() {
        MoaEditorSessionBinding binding = new MoaEditorSessionBinding();
        MoaEditorSensitivityPolicy.EditorIdentity editor = editor("pkg", 1, InputType.TYPE_CLASS_TEXT);
        MoaEditorSessionBinding.SessionToken session = binding.beginEditor(editor);
        binding.stageCandidate(session, "candidate");
        binding.finishEditor();

        assertTrue(binding.isSensitive(null));
        assertNull(binding.visibleCandidate(null));
        assertEquals(
                MoaEditorSessionBinding.Rejection.NO_ACTIVE_EDITOR,
                binding.stageCandidate(null, "candidate")
        );
        assertRejected(
                binding.authorizeCommit(session, editor),
                MoaEditorSessionBinding.Rejection.NO_ACTIVE_EDITOR
        );
    }

    @Test
    public void nullEditorBeginsUnsupportedFailClosedSession() {
        MoaEditorSessionBinding binding = new MoaEditorSessionBinding();
        MoaEditorSessionBinding.SessionToken session = binding.beginEditor(null);
        assertTrue(binding.isSensitive(session));
        assertEquals(
                MoaEditorSessionBinding.Rejection.SENSITIVE_EDITOR,
                binding.stageCandidate(session, "candidate")
        );
    }

    @Test
    public void sessionTokenEqualityAndHashBindGenerationAndEditor() {
        MoaEditorSensitivityPolicy.EditorIdentity editor = editor("pkg", 1, InputType.TYPE_CLASS_TEXT);
        MoaEditorSessionBinding.SessionToken first = new MoaEditorSessionBinding.SessionToken(
                1, editor, MoaEditorSensitivityPolicy.Classification.ORDINARY);
        MoaEditorSessionBinding.SessionToken same = new MoaEditorSessionBinding.SessionToken(
                1, editor, MoaEditorSensitivityPolicy.Classification.ORDINARY);
        MoaEditorSessionBinding.SessionToken otherGeneration = new MoaEditorSessionBinding.SessionToken(
                2, editor, MoaEditorSensitivityPolicy.Classification.ORDINARY);
        MoaEditorSessionBinding.SessionToken nullEditor = new MoaEditorSessionBinding.SessionToken(
                1, null, MoaEditorSensitivityPolicy.Classification.UNSUPPORTED);
        MoaEditorSessionBinding.SessionToken sameNullEditor = new MoaEditorSessionBinding.SessionToken(
                1, null, MoaEditorSensitivityPolicy.Classification.UNSUPPORTED);

        assertEquals(first, first);
        assertEquals(first, same);
        assertEquals(first.hashCode(), same.hashCode());
        assertFalse(first.equals(null));
        assertFalse(first.equals("session"));
        assertFalse(first.equals(otherGeneration));
        assertFalse(first.equals(new MoaEditorSessionBinding.SessionToken(
                1, editor, MoaEditorSensitivityPolicy.Classification.PRIVATE_EDITOR)));
        assertFalse(first.equals(new MoaEditorSessionBinding.SessionToken(
                1, editor("other", 1, InputType.TYPE_CLASS_TEXT),
                MoaEditorSensitivityPolicy.Classification.ORDINARY)));
        assertEquals(nullEditor, sameNullEditor);
        assertEquals(nullEditor.hashCode(), sameNullEditor.hashCode());
        assertFalse(nullEditor.equals(first));
    }

    private void assertRejected(
            MoaEditorSessionBinding.CommitDecision decision,
            MoaEditorSessionBinding.Rejection rejection
    ) {
        assertFalse(decision.allowed);
        assertNull(decision.exactText);
        assertEquals(rejection, decision.rejection);
    }

    private MoaEditorSensitivityPolicy.EditorIdentity editor(
            String packageName,
            int fieldId,
            int inputType
    ) {
        return new MoaEditorSensitivityPolicy.EditorIdentity(
                packageName, fieldId, inputType, 0, "body", "Message", "");
    }
}
