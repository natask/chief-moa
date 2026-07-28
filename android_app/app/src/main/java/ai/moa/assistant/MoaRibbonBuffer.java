package ai.moa.assistant;

import java.text.BreakIterator;
import java.util.Locale;

/**
 * The text a single ribbon owns for the current turn.
 *
 * Two bounds are load-bearing and both are enforced here:
 *
 * <ul>
 *   <li>{@code BUFFER_MAX_CHARS} retained clusters. Older text is dropped from
 *       the FRONT so the newest text always survives; dropping sets
 *       {@link #truncated()} so copy can say what it copied.</li>
 *   <li>{@code WINDOW_CHARS} rendered clusters. {@link #window()} is a TAIL
 *       window: the user always sees the newest text, never a scrollback.</li>
 * </ul>
 *
 * Truncation is grapheme-cluster safe. Ethiopic and CJK count one cluster per
 * rendered glyph, so a character-count cap can never split a combining sequence
 * and leave a broken glyph pinned at the ribbon's right edge. The segmenter is
 * {@link BreakIterator}; on Android it is ICU-backed and handles ZWJ emoji
 * sequences, while the plain JVM used by the unit tests splits those into their
 * component emoji. That difference costs at most a few extra clusters inside a
 * 140-cluster cap, so the visible tail is unaffected either way.
 *
 * Pure Java on purpose: this is the rule the whole no-reflow design rests on, so
 * it is unit tested rather than eyeballed on a phone.
 */
final class MoaRibbonBuffer {
    private final StringBuilder buffer = new StringBuilder();
    private boolean truncated;

    void clear() {
        buffer.setLength(0);
        truncated = false;
    }

    /** Append a stream delta. */
    void append(String delta) {
        if (delta == null || delta.isEmpty()) {
            return;
        }
        buffer.append(delta);
        retain();
    }

    /**
     * Replace the whole buffer. A partial transcript superseded by a merged final
     * transcript is a replace, not an append; the slide re-runs once.
     */
    void replace(String value) {
        buffer.setLength(0);
        truncated = false;
        if (value != null) {
            buffer.append(value);
        }
        retain();
    }

    boolean isEmpty() {
        return buffer.length() == 0;
    }

    /** The full retained text. Copy uses this, never the visible window. */
    String text() {
        return buffer.toString();
    }

    /** Whether retention dropped text from the front of this turn. */
    boolean truncated() {
        return truncated;
    }

    /** The rendered tail. Never a split cluster, never longer than the cap. */
    String window() {
        return tailClusters(buffer.toString(), MoaRibbonTokens.WINDOW_CHARS);
    }

    /**
     * What a copy of this buffer put on the clipboard, phrased for the
     * accessibility announcement. Android's own copy confirmation is not
     * duplicated; this string exists so a truncated copy is still honest.
     */
    String copyAnnouncement() {
        if (!truncated) {
            return "Copied";
        }
        return "Copied (from the last "
                + String.format(Locale.US, "%,d", MoaRibbonTokens.BUFFER_MAX_CHARS)
                + " characters)";
    }

    private void retain() {
        String kept = tailClusters(buffer.toString(), MoaRibbonTokens.BUFFER_MAX_CHARS);
        if (kept.length() == buffer.length()) {
            return;
        }
        buffer.setLength(0);
        buffer.append(kept);
        truncated = true;
    }

    /**
     * The last {@code maxClusters} grapheme clusters of {@code value}. Returns the
     * whole string when it is already short enough.
     */
    static String tailClusters(String value, int maxClusters) {
        if (value == null || value.isEmpty() || maxClusters <= 0) {
            return "";
        }
        BreakIterator clusters = BreakIterator.getCharacterInstance(Locale.ROOT);
        clusters.setText(value);
        clusters.last();
        int start = value.length();
        for (int taken = 0; taken < maxClusters; taken++) {
            int previous = clusters.previous();
            if (previous == BreakIterator.DONE) {
                break;
            }
            start = previous;
        }
        return start <= 0 ? value : value.substring(start);
    }

    /** Cluster count, for tests and for the retention bound's own assertions. */
    static int clusterCount(String value) {
        if (value == null || value.isEmpty()) {
            return 0;
        }
        BreakIterator clusters = BreakIterator.getCharacterInstance(Locale.ROOT);
        clusters.setText(value);
        int count = 0;
        while (clusters.next() != BreakIterator.DONE) {
            count++;
        }
        return count;
    }
}
