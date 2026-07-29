package ag.companion;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import org.json.JSONObject;
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Fail-closed, device-local resolver for handing an explicit media source to VLC. */
final class MoaVlcOpenPolicy {
    private static final int MAX_SOURCE_CHARS = 2_048;
    private static final Set<String> ALLOWED_KEYS = Set.of("app_name", "appName", "url", "uri",
            "source", "canonical_url", "title", "query", "search");
    private static final Set<String> VLC_LABELS = Set.of("vlc", "vlc for android");
    private MoaVlcOpenPolicy() {}

    static Result resolve(JSONObject input, PackageManager packageManager) {
        JSONObject args = input == null ? new JSONObject() : input;
        java.util.Iterator<String> keys = args.keys();
        while (keys.hasNext()) if (!ALLOWED_KEYS.contains(keys.next())) return Result.rejected("unsupported_selector");
        if (!isVlcLabel(firstNonEmpty(args.optString("app_name", ""), args.optString("appName", ""))))
            return Result.rejected("visible_vlc_label_required");
        String rawSource = firstNonEmpty(args.optString("url", ""), args.optString("uri", ""),
                args.optString("source", ""), args.optString("canonical_url", ""));
        if (rawSource.isEmpty()) return Result.needsSource();
        String validated = validatedSource(rawSource);
        if (validated.isEmpty()) return Result.rejected("validated_https_or_content_uri_required");
        Uri source = Uri.parse(validated);
        if (packageManager == null) return Result.notFound();
        Intent probe = new Intent(Intent.ACTION_VIEW, source);
        List<ResolveInfo> handlers;
        try { handlers = packageManager.queryIntentActivities(probe, PackageManager.MATCH_DEFAULT_ONLY); }
        catch (RuntimeException unavailable) { handlers = Collections.emptyList(); }
        List<MoaAppLaunchPolicy.Candidate> candidates = new ArrayList<>();
        for (ResolveInfo info : handlers == null ? Collections.<ResolveInfo>emptyList() : handlers) {
            if (info == null || info.activityInfo == null || !info.activityInfo.exported) continue;
            CharSequence loaded;
            try { loaded = info.loadLabel(packageManager); } catch (RuntimeException unavailable) { continue; }
            String label = loaded == null ? "" : loaded.toString();
            if (isVlcLabel(label)) candidates.add(new MoaAppLaunchPolicy.Candidate(
                    label, info.activityInfo.packageName, info.activityInfo.name));
        }
        MoaAppLaunchPolicy.Resolution resolution = MoaAppLaunchPolicy.resolve("VLC", candidates);
        if (resolution.status == MoaAppLaunchPolicy.Status.NOT_FOUND) return Result.notFound();
        if (resolution.status != MoaAppLaunchPolicy.Status.MATCH) return Result.ambiguous();
        Intent explicit = new Intent(Intent.ACTION_VIEW, source)
                .setClassName(resolution.candidate.packageName, resolution.candidate.activityName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return Result.match(resolution.candidate.packageName, explicit);
    }

    static String validatedSource(String value) {
        String raw = value == null ? "" : value.trim();
        if (raw.isEmpty() || raw.length() > MAX_SOURCE_CHARS || raw.regionMatches(true, 0, "intent:", 0, 7)
                || raw.regionMatches(true, 0, "file:", 0, 5) || raw.startsWith("/")) return "";
        try {
            URI parsed = new URI(raw);
            String scheme = parsed.getScheme() == null ? "" : parsed.getScheme().toLowerCase(Locale.US);
            if ("https".equals(scheme)) return parsed.getHost() == null || parsed.getHost().isBlank() ? "" : raw;
            if ("content".equals(scheme)) return parsed.getAuthority() == null || parsed.getAuthority().isBlank() ? "" : raw;
        } catch (Exception ignored) {}
        return "";
    }

    static boolean isVlcLabel(String value) { return VLC_LABELS.contains(MoaAppLaunchPolicy.normalizeLabel(value)); }
    private static String firstNonEmpty(String... values) {
        for (String value : values) if (value != null && !value.trim().isEmpty()) return value.trim();
        return "";
    }
    enum Status { MATCH, NEEDS_SOURCE, NOT_FOUND, AMBIGUOUS, REJECTED }
    static final class Result {
        final Status status; final String packageName; final Intent intent; final String reason;
        private Result(Status status, String packageName, Intent intent, String reason) {
            this.status = status; this.packageName = packageName; this.intent = intent; this.reason = reason;
        }
        static Result match(String packageName, Intent intent) { return new Result(Status.MATCH, packageName, intent, ""); }
        static Result needsSource() { return new Result(Status.NEEDS_SOURCE, "vlc", null, "needs_source"); }
        static Result notFound() { return new Result(Status.NOT_FOUND, "vlc", null, "vlc_not_found"); }
        static Result ambiguous() { return new Result(Status.AMBIGUOUS, "vlc", null, "vlc_ambiguous"); }
        static Result rejected(String reason) { return new Result(Status.REJECTED, "vlc", null, reason); }
    }
}
