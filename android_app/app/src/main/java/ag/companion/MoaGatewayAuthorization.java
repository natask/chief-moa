package ag.companion;

/** Formats gateway authorization without confusing user-bound devices with legacy bearers. */
final class MoaGatewayAuthorization {
    private static final String DEVICE_PREFIX = "ag_dev_v1.";

    private MoaGatewayAuthorization() {
    }

    static String headerValue(String token) {
        String value = safe(token);
        if (value.isEmpty()) return "";
        return (value.startsWith(DEVICE_PREFIX) ? "Device " : "Bearer ") + value;
    }

    static boolean isDeviceCredential(String token) {
        return safe(token).startsWith(DEVICE_PREFIX);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}
