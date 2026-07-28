package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.util.Locale;

/**
 * Bounded, content-free identity for the Android app/window most recently
 * observed by the local accessibility service.
 */
final class MoaActiveAppDescriptor {
    static final long FRESH_FOR_MS = 15_000L;
    private static final int MAX_IDENTITY_CHARS = 255;

    private MoaActiveAppDescriptor() {
    }

    static JSONObject create(
            boolean serviceRunning,
            String packageName,
            String className,
            long observedAtMs,
            long nowMs
    ) {
        String boundedPackage = boundedIdentity(packageName);
        String boundedClass = boundedIdentity(className);
        boolean available = serviceRunning && !boundedPackage.isEmpty() && observedAtMs > 0L;
        long ageMs = available ? Math.max(0L, nowMs - observedAtMs) : 0L;
        boolean fresh = available && ageMs <= FRESH_FOR_MS;
        String availability = !available ? "unavailable" : fresh ? "available" : "stale";

        JSONObject descriptor = new JSONObject();
        try {
            descriptor.put("version", 1);
            descriptor.put("schema_version", 1);
            descriptor.put("surface", "android");
            descriptor.put("availability", availability);
            if (!available) {
                descriptor.put("reason", serviceRunning ? "no_active_app_observation" : "accessibility_service_not_running");
            } else if (!fresh) {
                descriptor.put("reason", "observation_stale");
            }
            descriptor.put("available", available);
            descriptor.put("application_id", boundedPackage);
            descriptor.put("package_name", boundedPackage);
            descriptor.put("class_name", boundedClass);
            descriptor.put("captured_at", available ? Instant.ofEpochMilli(observedAtMs).toString() : JSONObject.NULL);
            descriptor.put("captured_at_ms", available ? observedAtMs : 0L);
            descriptor.put("observed_at_ms", available ? observedAtMs : 0L);
            descriptor.put("age_ms", ageMs);
            descriptor.put("fresh", fresh);
            descriptor.put("freshness", !available ? "unavailable" : fresh ? "fresh" : "stale");
            descriptor.put("content_included", false);

            if (available) {
                JSONObject application = new JSONObject();
                application.put("kind", "native_app");
                application.put("id", boundedPackage);
                application.put("class_name", boundedClass);
                descriptor.put("application", application);
            } else {
                descriptor.put("application", JSONObject.NULL);
            }

            JSONObject privacy = new JSONObject();
            privacy.put("page_content_included", false);
            privacy.put("full_url_included", false);
            privacy.put("query_included", false);
            privacy.put("fragment_included", false);
            descriptor.put("privacy", privacy);
        } catch (JSONException ignored) {
            // org.json's primitive/string puts do not fail in practice.
        }
        return descriptor;
    }

    static JSONArray executionAdapters(
            boolean serviceRunning,
            String packageName,
            String className,
            long observedAtMs,
            long nowMs
    ) {
        JSONObject context = create(serviceRunning, packageName, className, observedAtMs, nowMs);
        boolean contextIsFresh = "available".equals(context.optString("availability"));
        JSONObject adapter = new JSONObject();
        try {
            adapter.put("version", 1);
            adapter.put("id", "android.accessibility.local_session");
            adapter.put("adapter", "android.accessibility.local_session");
            adapter.put("kind", "accessibility");
            adapter.put("authority", "device_local");
            adapter.put("auth_mode", "android_permission");
            adapter.put("available", serviceRunning);
            adapter.put("status", serviceRunning ? "available" : "unavailable");
            adapter.put("unavailable_reason", serviceRunning ? JSONObject.NULL : "accessibility_service_not_running");
            adapter.put("credential_source", "android_local_permission");
            adapter.put("authentication_state", "not_inspected");
            if (contextIsFresh) {
                JSONObject binding = new JSONObject();
                binding.put("application_id", context.optString("application_id"));
                binding.put("class_name", context.optString("class_name"));
                binding.put("captured_at", context.opt("captured_at"));
                adapter.put("context_binding", binding);
            } else {
                adapter.put("context_binding", JSONObject.NULL);
            }
            adapter.put("modes", new JSONArray()
                    .put("accessibility_read")
                    .put("accessibility_navigation"));
            adapter.put("capabilities", new JSONArray()
                    .put("screen.summary")
                    .put("screen.tap_text")
                    .put("screen.set_text")
                    .put("screen.scroll"));
            adapter.put("constraints", new JSONArray()
                    .put("local_allowlist_validation")
                    .put("no_cookie_export")
                    .put("no_provider_credentials")
                    .put("proposal_before_execution")
                    .put("expected_package_revalidation")
                    .put("device_local_execution"));
        } catch (JSONException ignored) {
        }
        return new JSONArray().put(adapter);
    }

    static boolean packageMatches(String expectedPackage, String actualPackage) {
        String expected = normalizedPackage(expectedPackage);
        String actual = normalizedPackage(actualPackage);
        return !expected.isEmpty() && expected.equals(actual);
    }

    static String boundedIdentity(String value) {
        String safe = value == null ? "" : value.trim();
        if (safe.length() <= MAX_IDENTITY_CHARS) {
            return safe;
        }
        return safe.substring(0, MAX_IDENTITY_CHARS);
    }

    private static String normalizedPackage(String value) {
        return boundedIdentity(value).toLowerCase(Locale.US);
    }
}
