package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class MoaTranscriptViewportTest {
    @Test
    public void transcriptStartsAtOneLineAndExpandsToFive() {
        assertEquals(1, MoaTranscriptViewport.maxLines(false));
        assertEquals(5, MoaTranscriptViewport.maxLines(true));
    }

    @Test
    public void expandedViewportIsLargerButBounded() {
        assertEquals(68, MoaTranscriptViewport.bodyHeightDp(false));
        assertEquals(176, MoaTranscriptViewport.bodyHeightDp(true));
    }
}
