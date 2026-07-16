package ai.moa.assistant;

import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

final class MoaScreenshotPolicy {
    static final int MAX_WIDTH = 1280;
    static final int MAX_HEIGHT = 1280;
    static final int MAX_ENCODED_BYTES = 420 * 1024;
    static final int INITIAL_JPEG_QUALITY = 85;
    static final int MIN_JPEG_QUALITY = 35;
    static final int JPEG_QUALITY_STEP = 10;
    static final long MAX_OBSERVATION_AGE_MS = 2500L;

    enum DenialReason {
        NONE,
        CONSENT_REQUIRED,
        CONSENT_ALREADY_USED,
        UNSUPPORTED_ANDROID_VERSION,
        ACCESSIBILITY_UNAVAILABLE,
        TARGET_REQUIRED,
        TARGET_MISMATCH,
        STALE_OBSERVATION,
        SECURE_CONTENT,
        CAPTURE_FAILED,
        IMAGE_UNAVAILABLE,
        IMAGE_TOO_LARGE
    }

    static final class Request {
        final String expectedPackage;
        final long requestedAtMs;
        private final AtomicBoolean consumed = new AtomicBoolean(false);

        private Request(String expectedPackage, long requestedAtMs) {
            this.expectedPackage = normalizePackage(expectedPackage);
            this.requestedAtMs = requestedAtMs;
        }

        static Request issueExplicitConsent(String expectedPackage, long requestedAtMs) {
            return new Request(expectedPackage, requestedAtMs);
        }

        private boolean consume() {
            return consumed.compareAndSet(false, true);
        }

        private boolean isConsumed() {
            return consumed.get();
        }
    }

    static final class Observation {
        final boolean accessibilityAvailable;
        final boolean platformSupported;
        final String packageName;
        final long observedAtMs;
        final boolean secureContent;

        Observation(
                boolean accessibilityAvailable,
                boolean platformSupported,
                String packageName,
                long observedAtMs,
                boolean secureContent
        ) {
            this.accessibilityAvailable = accessibilityAvailable;
            this.platformSupported = platformSupported;
            this.packageName = normalizePackage(packageName);
            this.observedAtMs = observedAtMs;
            this.secureContent = secureContent;
        }
    }

    private MoaScreenshotPolicy() {
    }

    static DenialReason authorizeAndConsume(Request request, Observation observation, long nowMs) {
        if (request == null) {
            return DenialReason.CONSENT_REQUIRED;
        }
        if (!request.consume()) {
            return DenialReason.CONSENT_ALREADY_USED;
        }
        return validateBoundaries(request, observation, nowMs);
    }

    static DenialReason revalidate(Request request, Observation observation, long nowMs) {
        if (request == null || !request.isConsumed()) {
            return DenialReason.CONSENT_REQUIRED;
        }
        return validateBoundaries(request, observation, nowMs);
    }

    private static DenialReason validateBoundaries(Request request, Observation observation, long nowMs) {
        if (request.expectedPackage.isEmpty()) {
            return DenialReason.TARGET_REQUIRED;
        }
        if (observation == null || !observation.accessibilityAvailable) {
            return DenialReason.ACCESSIBILITY_UNAVAILABLE;
        }
        if (!observation.platformSupported) {
            return DenialReason.UNSUPPORTED_ANDROID_VERSION;
        }
        if (!request.expectedPackage.equals(observation.packageName)) {
            return DenialReason.TARGET_MISMATCH;
        }
        if (observation.secureContent) {
            return DenialReason.SECURE_CONTENT;
        }
        if (!isFresh(observation.observedAtMs, request.requestedAtMs, nowMs)) {
            return DenialReason.STALE_OBSERVATION;
        }
        return DenialReason.NONE;
    }

    static int[] boundedDimensions(int width, int height) {
        if (width <= 0 || height <= 0) {
            return new int[]{0, 0};
        }
        double scale = Math.min(1.0d, Math.min(
                (double) MAX_WIDTH / width,
                (double) MAX_HEIGHT / height
        ));
        return new int[]{
                Math.max(1, (int) Math.floor(width * scale)),
                Math.max(1, (int) Math.floor(height * scale))
        };
    }

    static int nextJpegQuality(int currentQuality) {
        if (currentQuality <= MIN_JPEG_QUALITY) {
            return -1;
        }
        return Math.max(MIN_JPEG_QUALITY, currentQuality - JPEG_QUALITY_STEP);
    }

    static boolean encodedSizeAllowed(int byteCount) {
        return byteCount > 0 && byteCount <= MAX_ENCODED_BYTES;
    }

    private static boolean isFresh(long observedAtMs, long requestedAtMs, long nowMs) {
        if (observedAtMs <= 0L || requestedAtMs <= 0L || nowMs < requestedAtMs) {
            return false;
        }
        return observedAtMs <= nowMs
                && nowMs - observedAtMs <= MAX_OBSERVATION_AGE_MS
                && nowMs - requestedAtMs <= MAX_OBSERVATION_AGE_MS;
    }

    private static String normalizePackage(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.US);
    }
}
