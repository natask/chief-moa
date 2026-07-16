package ai.moa.assistant;

import java.util.Arrays;

final class MoaScreenshotCapture {
    private final byte[] jpegBytes;
    final String packageName;
    final long capturedAtMs;
    final int width;
    final int height;
    final String sha256;

    MoaScreenshotCapture(
            byte[] jpegBytes,
            String packageName,
            long capturedAtMs,
            int width,
            int height,
            String sha256
    ) {
        this.jpegBytes = jpegBytes == null ? new byte[0] : Arrays.copyOf(jpegBytes, jpegBytes.length);
        this.packageName = packageName == null ? "" : packageName;
        this.capturedAtMs = capturedAtMs;
        this.width = width;
        this.height = height;
        this.sha256 = sha256 == null ? "" : sha256;
    }

    byte[] jpegBytes() {
        return Arrays.copyOf(jpegBytes, jpegBytes.length);
    }
}
