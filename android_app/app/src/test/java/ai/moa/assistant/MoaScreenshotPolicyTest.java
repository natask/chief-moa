package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaScreenshotPolicyTest {
    private static final long NOW = 10_000L;

    @Test
    public void allowsExplicitFreshMatchingNonSecureCapture() {
        assertEquals(MoaScreenshotPolicy.DenialReason.NONE, authorize(
                request(true, " Com.Example.Mail ", NOW),
                observation(true, true, "com.example.mail", NOW, false),
                NOW
        ));
    }

    @Test
    public void requiresOneShotExplicitConsentAndTarget() {
        assertEquals(MoaScreenshotPolicy.DenialReason.CONSENT_REQUIRED, authorize(
                request(false, "com.example.mail", NOW),
                observation(true, true, "com.example.mail", NOW, false),
                NOW
        ));
        assertEquals(MoaScreenshotPolicy.DenialReason.CONSENT_REQUIRED,
                MoaScreenshotPolicy.authorize(null, null, NOW));
        assertEquals(MoaScreenshotPolicy.DenialReason.TARGET_REQUIRED, authorize(
                request(true, "  ", NOW),
                observation(true, true, "", NOW, false),
                NOW
        ));
    }

    @Test
    public void deniesUnavailableAndUnsupportedPlatform() {
        assertEquals(MoaScreenshotPolicy.DenialReason.ACCESSIBILITY_UNAVAILABLE, authorize(
                request(true, "com.example.mail", NOW),
                observation(false, true, "com.example.mail", NOW, false),
                NOW
        ));
        assertEquals(MoaScreenshotPolicy.DenialReason.ACCESSIBILITY_UNAVAILABLE,
                MoaScreenshotPolicy.authorize(request(true, "com.example.mail", NOW), null, NOW));
        assertEquals(MoaScreenshotPolicy.DenialReason.UNSUPPORTED_ANDROID_VERSION, authorize(
                request(true, "com.example.mail", NOW),
                observation(true, false, "com.example.mail", NOW, false),
                NOW
        ));
    }

    @Test
    public void deniesMismatchedOrSecureTarget() {
        assertEquals(MoaScreenshotPolicy.DenialReason.TARGET_MISMATCH, authorize(
                request(true, "com.example.mail", NOW),
                observation(true, true, "com.example.bank", NOW, false),
                NOW
        ));
        assertEquals(MoaScreenshotPolicy.DenialReason.SECURE_CONTENT, authorize(
                request(true, "com.example.mail", NOW),
                observation(true, true, "com.example.mail", NOW, true),
                NOW
        ));
    }

    @Test
    public void deniesStaleFutureAndInvalidObservations() {
        assertStale(1L, NOW, NOW);
        assertStale(NOW + 1L, NOW, NOW);
        assertStale(NOW, 0L, NOW);
        assertStale(NOW, NOW, NOW - 1L);
        assertStale(NOW, NOW - MoaScreenshotPolicy.MAX_OBSERVATION_AGE_MS - 1L, NOW);
    }

    @Test
    public void revalidationUsesSameFailClosedRules() {
        assertEquals(MoaScreenshotPolicy.DenialReason.TARGET_MISMATCH,
                MoaScreenshotPolicy.revalidate(
                        request(true, "com.example.mail", NOW),
                        observation(true, true, "com.example.chat", NOW, false),
                        NOW
                ));
    }

    @Test
    public void dimensionsStayWithinBothBounds() {
        assertArrayEquals(new int[]{0, 0}, MoaScreenshotPolicy.boundedDimensions(0, 100));
        assertArrayEquals(new int[]{0, 0}, MoaScreenshotPolicy.boundedDimensions(100, -1));
        assertArrayEquals(new int[]{800, 600}, MoaScreenshotPolicy.boundedDimensions(800, 600));
        assertArrayEquals(new int[]{1280, 720}, MoaScreenshotPolicy.boundedDimensions(2560, 1440));
        assertArrayEquals(new int[]{720, 1280}, MoaScreenshotPolicy.boundedDimensions(1440, 2560));
    }

    @Test
    public void jpegQualityTerminatesAtMinimum() {
        assertEquals(75, MoaScreenshotPolicy.nextJpegQuality(85));
        assertEquals(MoaScreenshotPolicy.MIN_JPEG_QUALITY,
                MoaScreenshotPolicy.nextJpegQuality(MoaScreenshotPolicy.MIN_JPEG_QUALITY + 4));
        assertEquals(-1, MoaScreenshotPolicy.nextJpegQuality(MoaScreenshotPolicy.MIN_JPEG_QUALITY));
        assertEquals(-1, MoaScreenshotPolicy.nextJpegQuality(0));
    }

    @Test
    public void encodedBytesMustBePresentAndBounded() {
        assertFalse(MoaScreenshotPolicy.encodedSizeAllowed(0));
        assertFalse(MoaScreenshotPolicy.encodedSizeAllowed(-1));
        assertTrue(MoaScreenshotPolicy.encodedSizeAllowed(1));
        assertTrue(MoaScreenshotPolicy.encodedSizeAllowed(MoaScreenshotPolicy.MAX_ENCODED_BYTES));
        assertFalse(MoaScreenshotPolicy.encodedSizeAllowed(MoaScreenshotPolicy.MAX_ENCODED_BYTES + 1));
    }

    private static void assertStale(long observedAt, long requestedAt, long now) {
        assertEquals(MoaScreenshotPolicy.DenialReason.STALE_OBSERVATION, authorize(
                request(true, "com.example.mail", requestedAt),
                observation(true, true, "com.example.mail", observedAt, false),
                now
        ));
    }

    private static MoaScreenshotPolicy.DenialReason authorize(
            MoaScreenshotPolicy.Request request,
            MoaScreenshotPolicy.Observation observation,
            long now
    ) {
        return MoaScreenshotPolicy.authorize(request, observation, now);
    }

    private static MoaScreenshotPolicy.Request request(boolean consent, String packageName, long requestedAt) {
        return new MoaScreenshotPolicy.Request(consent, packageName, requestedAt);
    }

    private static MoaScreenshotPolicy.Observation observation(
            boolean available,
            boolean supported,
            String packageName,
            long observedAt,
            boolean secure
    ) {
        return new MoaScreenshotPolicy.Observation(available, supported, packageName, observedAt, secure);
    }
}
