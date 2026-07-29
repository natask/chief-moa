package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class MoaHistoryCopyTextTest {
    @Test
    public void preservesExactSingleSpeakerText() {
        assertEquals("  exact user text  ", MoaHistoryCopyText.compose("  exact user text  ", ""));
        assertEquals("assistant\ntext", MoaHistoryCopyText.compose(null, "assistant\ntext"));
    }

    @Test
    public void separatesTwoRetainedMessagesWithoutNormalizingThem() {
        assertEquals("user\n\nassistant", MoaHistoryCopyText.compose("user", "assistant"));
    }
}
