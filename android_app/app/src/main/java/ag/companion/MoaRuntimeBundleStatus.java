package ag.companion;

import android.widget.TextView;

import org.json.JSONObject;

/** Read-only projection of gateway-verified Tier-1 runtime configuration. */
final class MoaRuntimeBundleStatus {
    static final String SHELL_PROTOCOL = "1.0.0";

    final String state;
    final String bundleId;
    final String version;
    final String channel;
    final String manifestDigest;
    final boolean compatible;
    final boolean signingConfigured;

    private MoaRuntimeBundleStatus(String state, String bundleId, String version,
            String channel, String manifestDigest, boolean compatible,
            boolean signingConfigured) {
        this.state = state;
        this.bundleId = bundleId;
        this.version = version;
        this.channel = channel;
        this.manifestDigest = manifestDigest;
        this.compatible = compatible;
        this.signingConfigured = signingConfigured;
    }

    static MoaRuntimeBundleStatus load(MoaGatewayClient client) {
        try {
            return from(client.runtimeExtensions(SHELL_PROTOCOL));
        } catch (Exception ignored) {
            return new MoaRuntimeBundleStatus("base", "", "", "", "", true, false);
        }
    }

    static void showChecking(TextView view) {
        show(view, "Checking...", MoaColors.GOLD);
    }

    static void showGatewayUnavailable(TextView view) {
        show(view, "Base shell · gateway unavailable", MoaColors.GOLD);
    }

    void render(TextView view) {
        show(view, summary(), compatible ? MoaColors.OK : MoaColors.WARN);
    }

    static MoaRuntimeBundleStatus from(JSONObject response) {
        JSONObject runtime = response == null ? null : response.optJSONObject("runtime");
        JSONObject bundle = runtime == null ? null : runtime.optJSONObject("runtime_bundle");
        if (bundle == null
                || !"ag.runtime-config-status.v1".equals(bundle.optString("schema", ""))) {
            throw new IllegalArgumentException("runtime bundle status is invalid");
        }
        String state = boundedState(bundle.optString("state", ""));
        boolean signingConfigured = bundle.optBoolean("signing_configured", false);
        JSONObject active = bundle.optJSONObject("active");
        if (active == null) {
            if (!"base".equals(state)) {
                throw new IllegalArgumentException("active runtime bundle is missing");
            }
            return new MoaRuntimeBundleStatus(state, "", "", "", "", true,
                    signingConfigured);
        }
        JSONObject manifest = active.optJSONObject("manifest");
        JSONObject compatibility = manifest == null
                ? null : manifest.optJSONObject("compatibility");
        String id = safe(active.optString("artifact_id", ""), 100);
        String version = safe(manifest == null ? "" : manifest.optString("version", ""), 40);
        String channel = safe(manifest == null ? "" : manifest.optString("channel", ""), 20);
        String digest = safe(active.optString("manifest_digest", ""), 64);
        boolean compatible = active.optBoolean("compatible", false)
                && compatibility != null
                && "ag.android.runtime".equals(compatibility.optString("protocol", ""))
                && inRange(SHELL_PROTOCOL,
                        compatibility.optString("min_version", ""),
                        compatibility.optString("max_version", ""));
        if (id.isEmpty() || !isSemver(version) || !digest.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("active runtime bundle identity is invalid");
        }
        if ("healthy".equals(state) && !compatible) {
            throw new IllegalArgumentException("healthy runtime bundle is incompatible");
        }
        return new MoaRuntimeBundleStatus(state, id, version, channel, digest,
                compatible, signingConfigured);
    }

    String summary() {
        if ("base".equals(state)) {
            return signingConfigured ? "Base runtime · no bundle active"
                    : "Base runtime · signing not configured";
        }
        if (!compatible || "incompatible_client".equals(state)) {
            return "Bundle " + version + " needs a newer app shell";
        }
        return "Bundle " + version + " · " + channel + " · healthy";
    }

    private static String boundedState(String value) {
        return switch (value == null ? "" : value.trim()) {
            case "base", "healthy", "incompatible_client" -> value.trim();
            default -> throw new IllegalArgumentException("runtime bundle state is invalid");
        };
    }

    private static boolean inRange(String current, String minimum, String maximum) {
        return isSemver(current) && isSemver(minimum) && isSemver(maximum)
                && compare(current, minimum) >= 0 && compare(current, maximum) <= 0;
    }

    private static int compare(String first, String second) {
        String[] left = first.split("\\.");
        String[] right = second.split("\\.");
        for (int i = 0; i < 3; i++) {
            int compared = Integer.compare(Integer.parseInt(left[i]),
                    Integer.parseInt(right[i]));
            if (compared != 0) return compared;
        }
        return 0;
    }

    private static boolean isSemver(String value) {
        return value != null && value.matches("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)");
    }

    private static String safe(String value, int max) {
        String text = value == null ? "" : value.trim();
        return text.substring(0, Math.min(text.length(), max));
    }

    private static void show(TextView view, String text, int color) {
        if (view == null) return;
        view.setText(text);
        view.setTextColor(color);
    }
}
