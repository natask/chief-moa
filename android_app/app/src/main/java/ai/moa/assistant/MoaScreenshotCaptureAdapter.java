package ai.moa.assistant;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Bitmap;
import android.graphics.ColorSpace;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.util.Locale;

final class MoaScreenshotCaptureAdapter {
    interface Callback {
        void onCaptured(MoaScreenshotCapture capture);

        void onDenied(MoaScreenshotPolicy.DenialReason reason);
    }

    private static final int MAX_SECURE_SCAN_NODES = 128;

    private final MoaAccessibilityService service;

    MoaScreenshotCaptureAdapter(MoaAccessibilityService service) {
        this.service = service;
    }

    void capture(MoaScreenshotPolicy.Request request, Callback callback) {
        long nowMs = System.currentTimeMillis();
        MoaScreenshotPolicy.Observation initial = currentObservation(nowMs);
        MoaScreenshotPolicy.DenialReason denial = MoaScreenshotPolicy.authorize(request, initial, nowMs);
        if (denial != MoaScreenshotPolicy.DenialReason.NONE) {
            callback.onDenied(denial);
            return;
        }

        service.takeScreenshot(Display.DEFAULT_DISPLAY, service.getMainExecutor(),
                new AccessibilityService.TakeScreenshotCallback() {
                    @Override
                    public void onSuccess(AccessibilityService.ScreenshotResult result) {
                        handleSuccess(request, callback, result);
                    }

                    @Override
                    public void onFailure(int errorCode) {
                        callback.onDenied(errorCode == AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW
                                ? MoaScreenshotPolicy.DenialReason.SECURE_CONTENT
                                : MoaScreenshotPolicy.DenialReason.CAPTURE_FAILED);
                    }
                });
    }

    private void handleSuccess(
            MoaScreenshotPolicy.Request request,
            Callback callback,
            AccessibilityService.ScreenshotResult result
    ) {
        long nowMs = System.currentTimeMillis();
        MoaScreenshotPolicy.Observation current = currentObservation(nowMs);
        MoaScreenshotPolicy.DenialReason denial = MoaScreenshotPolicy.revalidate(request, current, nowMs);
        if (denial != MoaScreenshotPolicy.DenialReason.NONE) {
            closeBuffer(result);
            callback.onDenied(denial);
            return;
        }

        EncodedImage image = encodeBounded(result);
        if (image == null) {
            callback.onDenied(MoaScreenshotPolicy.DenialReason.IMAGE_UNAVAILABLE);
            return;
        }
        if (!MoaScreenshotPolicy.encodedSizeAllowed(image.bytes.length)) {
            callback.onDenied(MoaScreenshotPolicy.DenialReason.IMAGE_TOO_LARGE);
            return;
        }
        callback.onCaptured(new MoaScreenshotCapture(
                image.bytes,
                current.packageName,
                nowMs,
                image.width,
                image.height,
                sha256(image.bytes)
        ));
    }

    private MoaScreenshotPolicy.Observation currentObservation(long nowMs) {
        if (service == null) {
            return new MoaScreenshotPolicy.Observation(false, isPlatformSupported(), "", 0L, false);
        }
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        String packageName = root == null || root.getPackageName() == null
                ? ""
                : root.getPackageName().toString();
        boolean secureContent = containsPasswordNode(root, new int[]{0});
        return new MoaScreenshotPolicy.Observation(
                root != null,
                isPlatformSupported(),
                packageName,
                nowMs,
                secureContent
        );
    }

    private static boolean isPlatformSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
    }

    private static boolean containsPasswordNode(AccessibilityNodeInfo node, int[] scanned) {
        if (node == null) {
            return false;
        }
        // An unbounded tree cannot be proven free of sensitive editors. Treat
        // scan exhaustion as secure rather than capturing an unchecked tail.
        if (scanned[0] >= MAX_SECURE_SCAN_NODES) {
            return true;
        }
        scanned[0]++;
        if (node.isPassword()) {
            return true;
        }
        for (int index = 0; index < node.getChildCount(); index++) {
            if (containsPasswordNode(node.getChild(index), scanned)) {
                return true;
            }
        }
        return false;
    }

    private static EncodedImage encodeBounded(AccessibilityService.ScreenshotResult result) {
        if (result == null) {
            return null;
        }
        HardwareBuffer buffer = result.getHardwareBuffer();
        if (buffer == null) {
            return null;
        }
        Bitmap wrapped = null;
        Bitmap software = null;
        Bitmap bounded = null;
        try {
            ColorSpace colorSpace = result.getColorSpace();
            wrapped = Bitmap.wrapHardwareBuffer(buffer, colorSpace);
            if (wrapped == null) {
                return null;
            }
            software = wrapped.copy(Bitmap.Config.ARGB_8888, false);
            if (software == null) {
                return null;
            }
            int[] dimensions = MoaScreenshotPolicy.boundedDimensions(software.getWidth(), software.getHeight());
            if (dimensions[0] <= 0 || dimensions[1] <= 0) {
                return null;
            }
            bounded = dimensions[0] == software.getWidth() && dimensions[1] == software.getHeight()
                    ? software
                    : Bitmap.createScaledBitmap(software, dimensions[0], dimensions[1], true);
            for (int quality = MoaScreenshotPolicy.INITIAL_JPEG_QUALITY;
                 quality >= MoaScreenshotPolicy.MIN_JPEG_QUALITY;
                 quality = MoaScreenshotPolicy.nextJpegQuality(quality)) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                if (!bounded.compress(Bitmap.CompressFormat.JPEG, quality, output)) {
                    return null;
                }
                byte[] bytes = output.toByteArray();
                if (MoaScreenshotPolicy.encodedSizeAllowed(bytes.length)) {
                    return new EncodedImage(bytes, bounded.getWidth(), bounded.getHeight());
                }
                if (quality == MoaScreenshotPolicy.MIN_JPEG_QUALITY) {
                    break;
                }
            }
            return new EncodedImage(new byte[0], bounded.getWidth(), bounded.getHeight());
        } finally {
            if (bounded != null && bounded != software) {
                bounded.recycle();
            }
            if (software != null) {
                software.recycle();
            }
            if (wrapped != null) {
                wrapped.recycle();
            }
            buffer.close();
        }
    }

    private static void closeBuffer(AccessibilityService.ScreenshotResult result) {
        if (result != null && result.getHardwareBuffer() != null) {
            result.getHardwareBuffer().close();
        }
    }

    private static String sha256(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder value = new StringBuilder(digest.length * 2);
            for (byte item : digest) {
                value.append(String.format(Locale.US, "%02x", item & 0xff));
            }
            return value.toString();
        } catch (Exception ignored) {
            return "";
        }
    }

    private static final class EncodedImage {
        final byte[] bytes;
        final int width;
        final int height;

        EncodedImage(byte[] bytes, int width, int height) {
            this.bytes = bytes;
            this.width = width;
            this.height = height;
        }
    }
}
