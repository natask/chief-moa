package ag.companion;

import org.junit.Test;

import java.util.Set;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaReleaseArtifactVerifierTest {
    @Test
    public void declaredSignerMustBelongToInstalledContinuitySet() {
        String current = "a".repeat(64);
        String rotated = "b".repeat(64);
        assertTrue(MoaReleaseArtifactVerifier.declaresInstalledSigner(
                Set.of(current, rotated), rotated));
        assertFalse(MoaReleaseArtifactVerifier.declaresInstalledSigner(
                Set.of(current), rotated));
        assertFalse(MoaReleaseArtifactVerifier.declaresInstalledSigner(
                Set.of(current), "not-a-digest"));
    }
}
