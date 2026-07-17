package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaTurnAdmissionPolicyTest {
    @Test public void rejectsMissingAndCaptureNoise() {
        assertFalse(MoaTurnAdmissionPolicy.hasUserText(null));
        assertFalse(MoaTurnAdmissionPolicy.hasUserText("   "));
        assertFalse(MoaTurnAdmissionPolicy.hasUserText("...?!"));
    }

    @Test public void acceptsWordsNumbersAndNonLatinSpeech() {
        assertTrue(MoaTurnAdmissionPolicy.hasUserText("stop this agent"));
        assertTrue(MoaTurnAdmissionPolicy.hasUserText("123"));
        assertTrue(MoaTurnAdmissionPolicy.hasUserText("አማርኛ"));
    }
}
