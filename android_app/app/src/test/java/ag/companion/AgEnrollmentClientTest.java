package ag.companion;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
public final class AgEnrollmentClientTest {
    private static final String ORIGIN = "https://api.agee.app";

    @Test public void exchangesCapabilityThenVerifiesContinuityBeforeConnected() throws Exception {
        FakeTransport transport = new FakeTransport(false);
        MoaDeviceCredentialStore store = new MoaDeviceCredentialStore(RuntimeEnvironment.getApplication());
        AgEnrollmentClient.Result result = client(transport).exchangeAndDiscover(
                "ag_enroll_v1." + "a".repeat(43), store, "android_test");

        assertEquals("owner_1", result.accountId);
        assertEquals("", transport.calls.get(0).authorization);
        assertTrue(transport.calls.get(1).authorization.startsWith("Device ag_dev_v1."));
        assertEquals("ag_enroll_v1." + "a".repeat(43),
                transport.calls.get(0).body.getString("enrollment_capability"));
        assertTrue(transport.calls.get(0).body.getString("credential_token").startsWith("ag_dev_v1."));
        MoaDeviceCredentialStore.EnrollmentCredential saved =
                store.loadEnrollmentCredential(ORIGIN, "android_test");
        assertNotNull(saved);
        assertTrue(saved.verified);
        assertEquals("owner_1", saved.accountId);
        assertFalse(saved.token.contains("ag_enroll_v1"));
    }

    @Test public void failedContinuityNeverMarksCredentialVerified() {
        FakeTransport transport = new FakeTransport(true);
        MoaDeviceCredentialStore store = new MoaDeviceCredentialStore(RuntimeEnvironment.getApplication());
        assertThrows(IllegalStateException.class, () -> client(transport).exchangeAndDiscover(
                "ag_enroll_v1." + "b".repeat(43), store, "android_test"));
        MoaDeviceCredentialStore.EnrollmentCredential saved =
                store.loadEnrollmentCredential(ORIGIN, "android_test");
        assertNotNull(saved);
        assertFalse(saved.verified);
    }

    @Test public void readsAccountSettingsWithTheScopedDeviceCredentialOnly() throws Exception {
        FakeTransport transport = new FakeTransport(false);
        MoaDeviceCredentialStore store = new MoaDeviceCredentialStore(RuntimeEnvironment.getApplication());
        client(transport).exchangeAndDiscover("ag_enroll_v1." + "c".repeat(43), store, "android_test");
        MoaDeviceCredentialStore.EnrollmentCredential saved =
                store.loadEnrollmentCredential(ORIGIN, "android_test");

        JSONObject settings = client(transport).readSettings(saved.token);

        Call call = transport.calls.get(transport.calls.size() - 1);
        assertEquals("/v1/device-enrollments/continuity/settings", call.path());
        assertEquals("Device " + saved.token, call.authorization());
        assertEquals(1, settings.getInt("settings_schema_version"));
        assertEquals("Aoede", settings.getJSONObject("settings").getString("voice"));

        AgSettingsRestore.Result restored = MoaPrefs.restoreAccountSettings(
                RuntimeEnvironment.getApplication(), settings);
        assertEquals(AgSettingsRestore.Status.RESTORED, restored.status);
        assertEquals("Aoede", new JSONObject(MoaPrefs.agentProfileJson(
                RuntimeEnvironment.getApplication())).getString("voice"));
        assertEquals(1, MoaPrefs.restoredSettingsSchemaVersion(RuntimeEnvironment.getApplication()));
    }

    @Test public void rejectsAStoredCredentialThatIsNotADeviceCredential() {
        assertThrows(IllegalStateException.class,
                () -> client(new FakeTransport(false)).readSettings("Bearer gateway-token"));
    }

    @Test public void rejectsBearerShapedInputAndRemotePlaintext() {
        assertThrows(IllegalArgumentException.class, () -> client(new FakeTransport(false)).exchangeAndDiscover(
                "gateway-bearer-token", new MoaDeviceCredentialStore(RuntimeEnvironment.getApplication()), "android_test"));
        assertThrows(IllegalArgumentException.class, () -> new AgEnrollmentClient("http://api.agee.app"));
    }

    private static AgEnrollmentClient client(FakeTransport transport) {
        return new AgEnrollmentClient(ORIGIN, new SecureRandom() {
            @Override public void nextBytes(byte[] bytes) { java.util.Arrays.fill(bytes, (byte) 7); }
        }, transport);
    }

    private static final class FakeTransport implements AgEnrollmentClient.Transport {
        final List<Call> calls = new ArrayList<>();
        final boolean failContinuity;
        FakeTransport(boolean failContinuity) { this.failContinuity = failContinuity; }
        @Override public JSONObject request(String method, String path, JSONObject body,
                String authorization) throws Exception {
            calls.add(new Call(path, body, authorization));
            if (path.endsWith("exchanges")) {
                return new JSONObject().put("device_credential", new JSONObject()
                        .put("device_id", "android_test").put("surface_id", "android")
                        .put("application_id", "ag.companion")
                        .put("scopes", new JSONArray().put("continuity.read")
                                .put("conversation.read").put("conversation.write").put("profile.read")));
            }
            if (path.endsWith("continuity/settings")) {
                return new JSONObject().put("schema_version", 1)
                        .put("settings_schema_version", 1)
                        .put("account_id", "owner_1").put("tenant_id", "tenant_1")
                        .put("profile_version", "prof_3")
                        .put("settings", new JSONObject().put("voice", "Aoede")
                                .put("assistant_name", "Ag"))
                        .put("local_state_transferred", false);
            }
            if (failContinuity) throw new IllegalStateException("invalid_device_credential");
            return new JSONObject().put("schema_version", 1)
                    .put("account_id", "owner_1").put("tenant_id", "tenant_1")
                    .put("restore", new JSONArray().put("conversations").put("sessions")
                            .put("runs").put("profile"))
                    .put("local_state_transferred", false);
        }
    }

    private record Call(String path, JSONObject body, String authorization) { }
}
