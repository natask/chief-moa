package ai.moa.assistant;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaScreenshotPolicyTest {
    private static final long NOW = 10_000L;

    @Test
    public void allowsExplicitFreshMatchingNonSecureCaptureOnce() {
        MoaScreenshotPolicy.Request request = request(" Com.Example.Mail ", NOW);

        assertEquals(MoaScreenshotPolicy.DenialReason.NONE, authorize(
                request,
                observation(true, true, "com.example.mail", NOW, false),
                NOW
        ));
        assertEquals(MoaScreenshotPolicy.DenialReason.CONSENT_ALREADY_USED, authorize(
                request,
                observation(true, true, "com.example.mail", NOW, false),
                NOW
        ));
    }

    @Test(timeout = 5_000L)
    public void concurrentReplayAuthorizesExactlyOnce() throws Exception {
        int workers = 24;
        MoaScreenshotPolicy.Request request = request("com.example.mail", NOW);
        MoaScreenshotPolicy.Observation observation = observation(
                true, true, "com.example.mail", NOW, false);
        ExecutorService executor = Executors.newFixedThreadPool(workers);
        CountDownLatch ready = new CountDownLatch(workers);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<MoaScreenshotPolicy.DenialReason>> results = new ArrayList<>();
        try {
            for (int index = 0; index < workers; index++) {
                results.add(executor.submit(() -> {
                    ready.countDown();
                    start.await();
                    return authorize(request, observation, NOW);
                }));
            }
            ready.await();
            start.countDown();

            int authorized = 0;
            int replayDenied = 0;
            for (Future<MoaScreenshotPolicy.DenialReason> result : results) {
                MoaScreenshotPolicy.DenialReason reason = result.get();
                if (reason == MoaScreenshotPolicy.DenialReason.NONE) {
                    authorized++;
                } else if (reason == MoaScreenshotPolicy.DenialReason.CONSENT_ALREADY_USED) {
                    replayDenied++;
                }
            }
            assertEquals(1, authorized);
            assertEquals(workers - 1, replayDenied);
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    public void deniedAttemptAlsoBurnsOneShotConsent() {
        MoaScreenshotPolicy.Request request = request("com.example.mail", NOW);
        assertEquals(MoaScreenshotPolicy.DenialReason.TARGET_MISMATCH, authorize(
                request,
                observation(true, true, "com.example.bank", NOW, false),
                NOW
        ));
        assertEquals(MoaScreenshotPolicy.DenialReason.CONSENT_ALREADY_USED, authorize(
                request,
                observation(true, true, "com.example.mail", NOW, false),
                NOW
        ));
    }

    @Test
    public void requiresIssuedConsentAndTarget() {
        assertEquals(MoaScreenshotPolicy.DenialReason.CONSENT_REQUIRED,
                MoaScreenshotPolicy.authorizeAndConsume(null, null, NOW));
        assertEquals(MoaScreenshotPolicy.DenialReason.TARGET_REQUIRED, authorize(
                request("  ", NOW),
                observation(true, true, "", NOW, false),
                NOW
        ));
    }

    @Test
    public void deniesUnavailableAndUnsupportedPlatform() {
        assertEquals(MoaScreenshotPolicy.DenialReason.ACCESSIBILITY_UNAVAILABLE, authorize(
                request("com.example.mail", NOW),
                observation(false, true, "com.example.mail", NOW, false),
                NOW
        ));
        assertEquals(MoaScreenshotPolicy.DenialReason.ACCESSIBILITY_UNAVAILABLE,
                authorize(request("com.example.mail", NOW), null, NOW));
        assertEquals(MoaScreenshotPolicy.DenialReason.UNSUPPORTED_ANDROID_VERSION, authorize(
                request("com.example.mail", NOW),
                observation(true, false, "com.example.mail", NOW, false),
                NOW
        ));
    }

    @Test
    public void deniesSecureTarget() {
        assertEquals(MoaScreenshotPolicy.DenialReason.SECURE_CONTENT, authorize(
                request("com.example.mail", NOW),
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
    public void revalidationRequiresConsumedGrantThenPreservesBoundaryChecks() {
        MoaScreenshotPolicy.Request unconsumed = request("com.example.mail", NOW);
        assertEquals(MoaScreenshotPolicy.DenialReason.CONSENT_REQUIRED,
                MoaScreenshotPolicy.revalidate(
                        unconsumed,
                        observation(true, true, "com.example.mail", NOW, false),
                        NOW
                ));
        assertEquals(MoaScreenshotPolicy.DenialReason.CONSENT_REQUIRED,
                MoaScreenshotPolicy.revalidate(null, null, NOW));

        MoaScreenshotPolicy.Request consumed = request("com.example.mail", NOW);
        assertEquals(MoaScreenshotPolicy.DenialReason.NONE, authorize(
                consumed,
                observation(true, true, "com.example.mail", NOW, false),
                NOW
        ));
        assertEquals(MoaScreenshotPolicy.DenialReason.TARGET_MISMATCH,
                MoaScreenshotPolicy.revalidate(
                        consumed,
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
                request("com.example.mail", requestedAt),
                observation(true, true, "com.example.mail", observedAt, false),
                now
        ));
    }

    private static MoaScreenshotPolicy.DenialReason authorize(
            MoaScreenshotPolicy.Request request,
            MoaScreenshotPolicy.Observation observation,
            long now
    ) {
        return MoaScreenshotPolicy.authorizeAndConsume(request, observation, now);
    }

    private static MoaScreenshotPolicy.Request request(String packageName, long requestedAt) {
        return MoaScreenshotPolicy.Request.issueExplicitConsent(packageName, requestedAt);
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
