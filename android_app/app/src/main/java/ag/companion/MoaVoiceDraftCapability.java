package ag.companion;

import org.json.JSONObject;

import java.net.URI;
import java.util.Locale;

/** Pure, URL-bound interpretation of the gateway's short-lived draft capability. */
final class MoaVoiceDraftCapability {
    static final long FRESHNESS_MS = 30_000L;
    static final String REVISION = "voice_drafts_v1";
    static final String STATE_MACHINE_REVISION = "voice_draft_state.v1";

    private MoaVoiceDraftCapability() {
    }

    static Snapshot fromHealth(String gatewayUrl, JSONObject health, long checkedAtEpochMs) {
        JSONObject voiceStream = health == null ? null : health.optJSONObject("voice_stream");
        JSONObject provider = voiceStream == null ? null : voiceStream.optJSONObject("provider");
        JSONObject advertised = provider == null
                ? null : provider.optJSONObject("voice_drafts_v1");
        boolean supported = isExact(advertised);
        return new Snapshot(
                normalizeGatewayUrl(gatewayUrl),
                supported,
                checkedAtEpochMs
        );
    }

    static boolean isExact(JSONObject advertised) {
        return advertised != null
                && advertised.optBoolean("supported", false)
                && REVISION.equals(advertised.optString("revision", ""))
                && STATE_MACHINE_REVISION.equals(
                        advertised.optString("state_machine_revision", ""));
    }

    static Snapshot unavailable(String gatewayUrl, long checkedAtEpochMs) {
        return new Snapshot(normalizeGatewayUrl(gatewayUrl), false, checkedAtEpochMs);
    }

    static String normalizeGatewayUrl(String value) {
        String raw = safe(value);
        if (raw.isEmpty()) {
            return "";
        }
        try {
            URI parsed = new URI(raw);
            String scheme = safe(parsed.getScheme()).toLowerCase(Locale.US);
            String host = safe(parsed.getHost()).toLowerCase(Locale.US);
            if (scheme.isEmpty() || host.isEmpty()) {
                return "";
            }
            int port = parsed.getPort();
            if (("https".equals(scheme) && port == 443)
                    || ("http".equals(scheme) && port == 80)
                    || ("wss".equals(scheme) && port == 443)
                    || ("ws".equals(scheme) && port == 80)) {
                port = -1;
            }
            String path = safe(parsed.getPath());
            while (path.endsWith("/") && path.length() > 1) {
                path = path.substring(0, path.length() - 1);
            }
            if ("/".equals(path)) {
                path = "";
            }
            return new URI(scheme, null, host, port, path, null, null).toString();
        } catch (Exception ignored) {
            return "";
        }
    }

    static final class Snapshot {
        final String gatewayUrl;
        final boolean supported;
        final long checkedAtEpochMs;

        Snapshot(String gatewayUrl, boolean supported, long checkedAtEpochMs) {
            this.gatewayUrl = safe(gatewayUrl);
            this.supported = supported;
            this.checkedAtEpochMs = checkedAtEpochMs;
        }

        boolean isFreshFor(String currentGatewayUrl, long nowEpochMs) {
            return supported && isFreshBoundTo(currentGatewayUrl, nowEpochMs);
        }

        boolean isFreshBoundTo(String currentGatewayUrl, long nowEpochMs) {
            if (gatewayUrl.isEmpty() || !gatewayUrl.equals(normalizeGatewayUrl(currentGatewayUrl))) {
                return false;
            }
            long ageMs = nowEpochMs - checkedAtEpochMs;
            return ageMs >= 0L && ageMs <= FRESHNESS_MS;
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}
