package ag.companion;

import android.content.Context;
import android.content.SharedPreferences;

/** App-private storage for the revocable release-control device credential. */
final class MoaDeviceCredentialStore implements MoaReleaseControlClient.DeviceCredentialState {
    private static final String PREFS = "moa_release_device_credential";
    private static final String KEY_ORIGIN = "origin";
    private static final String KEY_DEVICE = "device_id";
    private static final String KEY_SURFACE = "surface_id";
    private static final String KEY_TOKEN = "credential_token";
    private static final String KEY_IDEMPOTENCY = "idempotency_key";
    private static final String KEY_REGISTERED = "registered";
    private static final String KEY_ENROLLMENT_ORIGIN = "ag_enrollment_origin";
    private static final String KEY_ENROLLMENT_DEVICE = "ag_enrollment_device";
    private static final String KEY_ENROLLMENT_TOKEN = "ag_enrollment_credential";
    private static final String KEY_ENROLLMENT_VERIFIED = "ag_enrollment_verified";
    private static final String KEY_ENROLLMENT_ACCOUNT = "ag_enrollment_account";
    private final SharedPreferences preferences;

    MoaDeviceCredentialStore(Context context) {
        Context app = context == null ? null : context.getApplicationContext();
        if (app == null) throw new IllegalArgumentException("context is required");
        preferences = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized EnrollmentCredential loadEnrollmentCredential(String origin, String deviceId) {
        if (!safe(origin).equals(preferences.getString(KEY_ENROLLMENT_ORIGIN, ""))
                || !safe(deviceId).equals(preferences.getString(KEY_ENROLLMENT_DEVICE, ""))) return null;
        String token = preferences.getString(KEY_ENROLLMENT_TOKEN, "");
        if (safe(token).isEmpty()) return null;
        return new EnrollmentCredential(token,
                preferences.getBoolean(KEY_ENROLLMENT_VERIFIED, false),
                preferences.getString(KEY_ENROLLMENT_ACCOUNT, ""));
    }

    synchronized void saveEnrollmentCredential(String origin, String deviceId, String token,
            boolean verified, String accountId) {
        boolean saved = preferences.edit()
                .putString(KEY_ENROLLMENT_ORIGIN, safe(origin))
                .putString(KEY_ENROLLMENT_DEVICE, safe(deviceId))
                .putString(KEY_ENROLLMENT_TOKEN, safe(token))
                .putBoolean(KEY_ENROLLMENT_VERIFIED, verified)
                .putString(KEY_ENROLLMENT_ACCOUNT, safe(accountId)).commit();
        if (!saved) throw new IllegalStateException("Ag device credential could not be persisted");
    }

    static final class EnrollmentCredential {
        final String token;
        final boolean verified;
        final String accountId;
        EnrollmentCredential(String token, boolean verified, String accountId) {
            this.token = safe(token); this.verified = verified; this.accountId = safe(accountId);
        }
    }

    @Override
    public synchronized MoaReleaseControlClient.DeviceCredential load(
            String origin, String deviceId, String surfaceId) {
        if (!safe(origin).equals(preferences.getString(KEY_ORIGIN, ""))
                || !safe(deviceId).equals(preferences.getString(KEY_DEVICE, ""))
                || !safe(surfaceId).equals(preferences.getString(KEY_SURFACE, ""))) {
            return null;
        }
        String token = preferences.getString(KEY_TOKEN, "");
        String idempotency = preferences.getString(KEY_IDEMPOTENCY, "");
        if (safe(token).isEmpty() || safe(idempotency).isEmpty()) return null;
        return new MoaReleaseControlClient.DeviceCredential(
                token, idempotency, preferences.getBoolean(KEY_REGISTERED, false));
    }

    @Override
    public synchronized void save(
            String origin, String deviceId, String surfaceId,
            MoaReleaseControlClient.DeviceCredential credential) {
        if (credential == null) throw new IllegalArgumentException("credential is required");
        boolean saved = preferences.edit()
                .putString(KEY_ORIGIN, safe(origin))
                .putString(KEY_DEVICE, safe(deviceId))
                .putString(KEY_SURFACE, safe(surfaceId))
                .putString(KEY_TOKEN, credential.token)
                .putString(KEY_IDEMPOTENCY, credential.idempotencyKey)
                .putBoolean(KEY_REGISTERED, credential.registered)
                .commit();
        if (!saved) {
            throw new IllegalStateException("release-control device credential could not be persisted");
        }
    }

    private static String safe(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }
}
