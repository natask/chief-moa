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
    private final SharedPreferences preferences;

    MoaDeviceCredentialStore(Context context) {
        Context app = context == null ? null : context.getApplicationContext();
        if (app == null) throw new IllegalArgumentException("context is required");
        preferences = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
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
