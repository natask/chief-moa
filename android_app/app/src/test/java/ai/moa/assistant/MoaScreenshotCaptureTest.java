package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

public final class MoaScreenshotCaptureTest {
    @Test
    public void copiesImageBytesAndNormalizesNullMetadata() {
        byte[] source = new byte[]{1, 2, 3};
        MoaScreenshotCapture capture = new MoaScreenshotCapture(source, null, 42L, 8, 6, null);
        source[0] = 9;

        byte[] returned = capture.jpegBytes();
        returned[1] = 9;

        assertArrayEquals(new byte[]{1, 2, 3}, capture.jpegBytes());
        assertEquals("", capture.packageName);
        assertEquals(42L, capture.capturedAtMs);
        assertEquals(8, capture.width);
        assertEquals(6, capture.height);
        assertEquals("", capture.sha256);
    }

    @Test
    public void nullBytesBecomeEmpty() {
        MoaScreenshotCapture capture = new MoaScreenshotCapture(null, "app", 1L, 1, 1, "digest");

        assertArrayEquals(new byte[0], capture.jpegBytes());
        assertEquals("app", capture.packageName);
        assertEquals("digest", capture.sha256);
    }
}
