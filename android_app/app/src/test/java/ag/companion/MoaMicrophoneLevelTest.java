package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaMicrophoneLevelTest {
    @Test
    public void silenceAndFullScaleNormalizeWithinBounds() {
        assertEquals(0f, MoaMicrophoneLevel.normalizePcm16(new byte[80]), 0f);
        byte[] loud = new byte[80];
        for (int i = 0; i < loud.length; i += 2) {
            loud[i] = (byte) 0xff;
            loud[i + 1] = 0x7f;
        }
        assertEquals(1f, MoaMicrophoneLevel.normalizePcm16(loud), 0f);
    }

    @Test
    public void smoothingAttacksFasterThanItReleases() {
        float attack = MoaMicrophoneLevel.smooth(0f, 1f);
        float release = MoaMicrophoneLevel.smooth(1f, 0f);
        assertTrue(attack > 0.5f);
        assertTrue(release > attack);
    }
}
