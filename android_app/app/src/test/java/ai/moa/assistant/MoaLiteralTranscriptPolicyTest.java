package ai.moa.assistant;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public final class MoaLiteralTranscriptPolicyTest {
    @Test
    public void preservesFirstNonEmptyAlternativeExactly() {
        assertEquals("  Exact words.  ", MoaLiteralTranscriptPolicy.firstLiteral(
                Arrays.asList(null, "", "  Exact words.  ", "other")));
        assertEquals("   ", MoaLiteralTranscriptPolicy.firstLiteral(
                Arrays.asList("   ", "other")));
    }

    @Test
    public void absentAlternativesProduceNoCandidate() {
        assertNull(MoaLiteralTranscriptPolicy.firstLiteral(null));
        assertNull(MoaLiteralTranscriptPolicy.firstLiteral(Collections.emptyList()));
        assertNull(MoaLiteralTranscriptPolicy.firstLiteral(Arrays.asList(null, "")));
    }
}
