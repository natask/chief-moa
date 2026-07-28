package ai.moa.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaRibbonBufferTest {

    @Test
    public void shortTextRendersWholeAndCopiesWhole() {
        MoaRibbonBuffer buffer = new MoaRibbonBuffer();
        buffer.append("how much is the flight to Addis");

        assertEquals("how much is the flight to Addis", buffer.window());
        assertEquals("how much is the flight to Addis", buffer.text());
        assertFalse(buffer.truncated());
    }

    @Test
    public void windowIsATailNeverAHead() {
        MoaRibbonBuffer buffer = new MoaRibbonBuffer();
        buffer.append(repeat("a", 100));
        buffer.append(repeat("b", 100));

        String window = buffer.window();
        assertEquals(MoaRibbonTokens.WINDOW_CHARS, window.length());
        // The user always sees the newest text. There is no scroll-back.
        assertEquals(repeat("b", 100), window.substring(window.length() - 100));
        assertTrue(window.startsWith("a"));
    }

    @Test
    public void windowNeverExceedsTheClusterCap() {
        MoaRibbonBuffer buffer = new MoaRibbonBuffer();
        buffer.append(repeat("x", MoaRibbonTokens.WINDOW_CHARS * 3));

        assertEquals(MoaRibbonTokens.WINDOW_CHARS,
                MoaRibbonBuffer.clusterCount(buffer.window()));
    }

    @Test
    public void ethiopicCountsOneClusterPerRenderedGlyph() {
        // Ge'ez script: one code point per rendered glyph, six including the space.
        String amharic = "ሰላም ነው";
        MoaRibbonBuffer buffer = new MoaRibbonBuffer();
        buffer.append(amharic);

        assertEquals(amharic, buffer.window());
        assertEquals(6, MoaRibbonBuffer.clusterCount(amharic));
    }

    @Test
    public void truncationNeverSplitsASurrogatePair() {
        // An emoji is one cluster made of two code units. A naive substring
        // would cut it in half and pin a broken glyph at the ribbon's tail.
        String thumb = "\uD83D\uDC4D";
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < 200; i++) {
            text.append(thumb);
        }

        String tail = MoaRibbonBuffer.tailClusters(text.toString(), 3);

        assertEquals(thumb + thumb + thumb, tail);
        assertEquals(3, MoaRibbonBuffer.clusterCount(tail));
        assertEquals(6, tail.length());
    }

    @Test
    public void truncationNeverSplitsACombiningSequence() {
        // Devanagari conjunct plus a combining acute: several code points each,
        // one rendered glyph each.
        String conjunct = "\u0915\u094D\u0937\u093F";
        String accented = "e\u0301";
        String text = repeat("-", 300) + conjunct + accented;

        String tail = MoaRibbonBuffer.tailClusters(text, 2);

        assertEquals(conjunct + accented, tail);
        assertEquals(2, MoaRibbonBuffer.clusterCount(tail));
    }

    @Test
    public void retentionDropsFromTheFrontAndFlagsTheCopy() {
        MoaRibbonBuffer buffer = new MoaRibbonBuffer();
        buffer.append(repeat("o", MoaRibbonTokens.BUFFER_MAX_CHARS));
        assertFalse(buffer.truncated());

        buffer.append("TAIL");

        assertTrue(buffer.truncated());
        assertEquals(MoaRibbonTokens.BUFFER_MAX_CHARS,
                MoaRibbonBuffer.clusterCount(buffer.text()));
        assertTrue(buffer.text().endsWith("TAIL"));
        assertTrue(buffer.copyAnnouncement().contains("8,000"));
    }

    @Test
    public void copyReturnsTheFullBufferNotTheVisibleWindow() {
        MoaRibbonBuffer buffer = new MoaRibbonBuffer();
        buffer.append(repeat("z", 1000));

        assertEquals(1000, buffer.text().length());
        assertEquals(MoaRibbonTokens.WINDOW_CHARS, buffer.window().length());
    }

    @Test
    public void replaceSwapsTheWholeBufferForAFinalTranscript() {
        MoaRibbonBuffer buffer = new MoaRibbonBuffer();
        buffer.append("how much is the fli");
        buffer.replace("How much is the flight to Addis Ababa?");

        assertEquals("How much is the flight to Addis Ababa?", buffer.text());
        assertFalse(buffer.truncated());
    }

    @Test
    public void clearingLeavesNothingToPaint() {
        MoaRibbonBuffer buffer = new MoaRibbonBuffer();
        buffer.append("something");
        buffer.clear();

        assertTrue(buffer.isEmpty());
        assertEquals("", buffer.window());
        assertEquals("Copied", buffer.copyAnnouncement());
    }

    private static String repeat(String unit, int count) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < count; i++) {
            out.append(unit);
        }
        return out.toString();
    }
}
