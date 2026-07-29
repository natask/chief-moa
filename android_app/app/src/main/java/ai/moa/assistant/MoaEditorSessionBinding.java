package ai.moa.assistant;

/** Pure editor/candidate binding. A candidate is valid for exactly one editor generation. */
final class MoaEditorSessionBinding {
    enum Rejection {
        NONE,
        NO_ACTIVE_EDITOR,
        SENSITIVE_EDITOR,
        EMPTY_CANDIDATE,
        STALE_EDITOR,
        NO_CANDIDATE
    }

    private long nextGeneration;
    private SessionToken activeSession;
    private String candidate;

    SessionToken beginEditor(MoaEditorSensitivityPolicy.EditorIdentity editor) {
        nextGeneration++;
        candidate = null;
        if (editor == null) {
            editor = new MoaEditorSensitivityPolicy.EditorIdentity("", 0, 0, 0, "", "", "");
        }
        MoaEditorSensitivityPolicy.Classification classification =
                MoaEditorSensitivityPolicy.classify(editor);
        activeSession = new SessionToken(nextGeneration, editor, classification);
        return activeSession;
    }

    void finishEditor() {
        activeSession = null;
        candidate = null;
    }

    Rejection stageCandidate(SessionToken session, String exactText) {
        Rejection sessionRejection = validateSession(session, session == null ? null : session.editor);
        if (sessionRejection != Rejection.NONE) {
            candidate = null;
            return sessionRejection;
        }
        if (exactText == null || exactText.isEmpty()) {
            candidate = null;
            return Rejection.EMPTY_CANDIDATE;
        }
        candidate = exactText;
        return Rejection.NONE;
    }

    CommitDecision authorizeCommit(
            SessionToken session,
            MoaEditorSensitivityPolicy.EditorIdentity observedEditor
    ) {
        Rejection rejection = validateSession(session, observedEditor);
        if (rejection != Rejection.NONE) {
            return CommitDecision.rejected(rejection);
        }
        if (candidate == null) {
            return CommitDecision.rejected(Rejection.NO_CANDIDATE);
        }
        return CommitDecision.allowed(candidate);
    }

    String visibleCandidate(SessionToken session) {
        if (validateSession(session, session == null ? null : session.editor) != Rejection.NONE) {
            return null;
        }
        return candidate;
    }

    boolean isSensitive(SessionToken session) {
        return session == null
                || session.classification != MoaEditorSensitivityPolicy.Classification.ORDINARY;
    }

    Rejection validateEditor(
            SessionToken session,
            MoaEditorSensitivityPolicy.EditorIdentity observedEditor
    ) {
        return validateSession(session, observedEditor);
    }

    void clearCandidate() {
        candidate = null;
    }

    /** Returns staged text only for the currently active token, for terminal receipt formation. */
    String stagedCandidateForAttempt(SessionToken session) {
        return activeSession != null && activeSession.equals(session) ? candidate : null;
    }

    private Rejection validateSession(
            SessionToken session,
            MoaEditorSensitivityPolicy.EditorIdentity observedEditor
    ) {
        if (activeSession == null || session == null) {
            return Rejection.NO_ACTIVE_EDITOR;
        }
        if (!activeSession.equals(session)
                || observedEditor == null
                || !activeSession.editor.equals(observedEditor)) {
            return Rejection.STALE_EDITOR;
        }
        if (activeSession.classification != MoaEditorSensitivityPolicy.Classification.ORDINARY) {
            return Rejection.SENSITIVE_EDITOR;
        }
        return Rejection.NONE;
    }

    static final class SessionToken {
        final long generation;
        final MoaEditorSensitivityPolicy.EditorIdentity editor;
        final MoaEditorSensitivityPolicy.Classification classification;

        SessionToken(
                long generation,
                MoaEditorSensitivityPolicy.EditorIdentity editor,
                MoaEditorSensitivityPolicy.Classification classification
        ) {
            this.generation = generation;
            this.editor = editor;
            this.classification = classification;
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) {
                return true;
            }
            if (!(other instanceof SessionToken)) {
                return false;
            }
            SessionToken that = (SessionToken) other;
            if (generation != that.generation || classification != that.classification) {
                return false;
            }
            return editor == null ? that.editor == null : editor.equals(that.editor);
        }

        @Override
        public int hashCode() {
            int result = Long.hashCode(generation);
            result = 31 * result + (editor == null ? 0 : editor.hashCode());
            result = 31 * result + classification.hashCode();
            return result;
        }
    }

    static final class CommitDecision {
        final boolean allowed;
        final String exactText;
        final Rejection rejection;

        private CommitDecision(boolean allowed, String exactText, Rejection rejection) {
            this.allowed = allowed;
            this.exactText = exactText;
            this.rejection = rejection;
        }

        static CommitDecision allowed(String exactText) {
            return new CommitDecision(true, exactText, Rejection.NONE);
        }

        static CommitDecision rejected(Rejection rejection) {
            return new CommitDecision(false, null, rejection);
        }
    }
}
