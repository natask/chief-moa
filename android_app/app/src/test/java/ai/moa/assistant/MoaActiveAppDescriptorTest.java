package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaActiveAppDescriptorTest {
    @Test
    public void emitsBoundedFreshAndroidIdentityWithoutScreenContent() {
        JSONObject descriptor = MoaActiveAppDescriptor.create(
                true,
                "com.example.mail",
                "com.example.mail.InboxActivity",
                10_000L,
                11_250L
        );

        assertEquals(1, descriptor.optInt("schema_version"));
        assertEquals(1, descriptor.optInt("version"));
        assertEquals("android", descriptor.optString("surface"));
        assertEquals("available", descriptor.optString("availability"));
        assertEquals("com.example.mail", descriptor.optString("application_id"));
        assertEquals("com.example.mail", descriptor.optString("package_name"));
        assertEquals("com.example.mail.InboxActivity", descriptor.optString("class_name"));
        assertEquals(1_250L, descriptor.optLong("age_ms"));
        assertTrue(descriptor.optBoolean("available"));
        assertTrue(descriptor.optBoolean("fresh"));
        assertEquals("fresh", descriptor.optString("freshness"));
        assertEquals("1970-01-01T00:00:10Z", descriptor.optString("captured_at"));
        assertFalse(descriptor.optBoolean("content_included"));
        assertEquals("native_app", descriptor.optJSONObject("application").optString("kind"));
        assertFalse(descriptor.optJSONObject("privacy").optBoolean("page_content_included"));
        assertFalse(descriptor.has("summary"));
        assertFalse(descriptor.has("visible_text"));
    }

    @Test
    public void marksOldAndUnavailableObservationsExplicitly() {
        JSONObject stale = MoaActiveAppDescriptor.create(
                true,
                "com.example.browser",
                "BrowserActivity",
                1_000L,
                1_000L + MoaActiveAppDescriptor.FRESH_FOR_MS + 1L
        );
        assertFalse(stale.optBoolean("fresh"));
        assertEquals("stale", stale.optString("availability"));
        assertEquals("stale", stale.optString("freshness"));

        JSONObject unavailable = MoaActiveAppDescriptor.create(
                false,
                "com.example.browser",
                "BrowserActivity",
                1_000L,
                2_000L
        );
        assertFalse(unavailable.optBoolean("available"));
        assertEquals("unavailable", unavailable.optString("availability"));
        assertEquals(0L, unavailable.optLong("observed_at_ms"));
        assertEquals("unavailable", unavailable.optString("freshness"));
    }

    @Test
    public void advertisesOnlyDeviceLocalAccessibilityExecution() {
        JSONArray adapters = MoaActiveAppDescriptor.executionAdapters(
                true,
                "com.example.mail",
                "InboxActivity",
                10_000L,
                11_000L
        );
        JSONObject adapter = adapters.optJSONObject(0);
        assertEquals("android.accessibility.local_session", adapter.optString("adapter"));
        assertEquals("accessibility", adapter.optString("kind"));
        assertEquals("device_local", adapter.optString("authority"));
        assertTrue(adapter.optBoolean("available"));
        assertEquals("available", adapter.optString("status"));
        assertEquals("android_local_permission", adapter.optString("credential_source"));
        assertEquals("not_inspected", adapter.optString("authentication_state"));
        assertEquals("com.example.mail", adapter.optJSONObject("context_binding").optString("application_id"));
        assertTrue(adapter.optJSONArray("constraints").toString().contains("expected_package_revalidation"));
        assertTrue(adapter.optJSONArray("constraints").toString().contains("no_provider_credentials"));
    }

    @Test
    public void expectedPackageMustBePresentAndMatchExactly() {
        assertTrue(MoaActiveAppDescriptor.packageMatches("com.example.mail", "com.example.mail"));
        assertTrue(MoaActiveAppDescriptor.packageMatches(" COM.EXAMPLE.MAIL ", "com.example.mail"));
        assertFalse(MoaActiveAppDescriptor.packageMatches("com.example", "com.example.mail"));
        assertFalse(MoaActiveAppDescriptor.packageMatches("", "com.example.mail"));
        assertFalse(MoaActiveAppDescriptor.packageMatches(null, "com.example.mail"));
    }

    @Test
    public void truncatesUntrustedIdentityFields() {
        StringBuilder oversized = new StringBuilder();
        for (int i = 0; i < 400; i += 1) {
            oversized.append('x');
        }
        JSONObject descriptor = MoaActiveAppDescriptor.create(
                true,
                oversized.toString(),
                oversized.toString(),
                1L,
                1L
        );
        assertEquals(255, descriptor.optString("package_name").length());
        assertEquals(255, descriptor.optString("class_name").length());
    }
}
