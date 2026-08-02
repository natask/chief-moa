package ag.companion;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class MoaHistoryCopyTextTest {
    @Test
    public void preservesExactUserMessageText() {
        assertEquals("  exact user\nmessage  ",
                MoaHistoryCopyText.exact("  exact user\nmessage  "));
    }

    @Test
    public void preservesExactAssistantMessageText() {
        assertEquals("assistant\n\nmessage",
                MoaHistoryCopyText.exact("assistant\n\nmessage"));
    }

    @Test
    public void nullMessageHasNoClipboardPayload() {
        assertEquals("", MoaHistoryCopyText.exact(null));
    }
}
