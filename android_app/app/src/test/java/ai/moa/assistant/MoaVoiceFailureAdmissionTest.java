package ai.moa.assistant;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaVoiceFailureAdmissionTest {
    @Test public void failureCallbackAfterLocalCancelIsSuppressed() {
        MoaVoiceFailureAdmission admission = new MoaVoiceFailureAdmission();
        int session = admission.beginSession();
        AtomicInteger failureCallbacks = new AtomicInteger();

        admission.markLocalTermination();
        boolean admitted = admission.onSocketFailure(
                session, failureCallbacks::incrementAndGet);

        assertFalse(admitted);
        assertFalse(failureCallbacks.get() > 0);
    }

    @Test public void genuineFailureBeforeCancelIsReported() {
        MoaVoiceFailureAdmission admission = new MoaVoiceFailureAdmission();
        int session = admission.beginSession();
        AtomicInteger failureCallbacks = new AtomicInteger();

        boolean admitted = admission.onSocketFailure(
                session, failureCallbacks::incrementAndGet);

        assertTrue(admitted);
        assertTrue(failureCallbacks.get() == 1);
    }

    @Test public void queuedFailureIsRejectedAfterCancelOrReplacementSession() {
        MoaVoiceFailureAdmission admission = new MoaVoiceFailureAdmission();
        int firstSession = admission.beginSession();
        assertTrue(admission.shouldReportFailure(firstSession));

        admission.markLocalTermination();
        assertFalse(admission.shouldReportFailure(firstSession));

        int replacementSession = admission.beginSession();
        assertFalse(admission.isCurrentSession(firstSession));
        assertTrue(admission.shouldReportFailure(replacementSession));
    }
}
