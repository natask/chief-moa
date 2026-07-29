package ag.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Foreground-triggered, best-effort candidate discovery. It never selects or installs. */
final class MoaReleaseCandidateNotifier {
    private static final String CHANNEL_ID = "moa_release_candidates";
    private static final int NOTIFICATION_ID = 5703;
    private static final String PREFS = "moa_release_candidate_notice";
    private static final String LAST_BUNDLE = "last_eligible_bundle";

    private MoaReleaseCandidateNotifier() { }

    static void checkAsync(Context context, String gatewayUrl, String gatewayToken, String deviceId) {
        Context app = context.getApplicationContext();
        if (safe(gatewayUrl).isEmpty() || safe(deviceId).isEmpty()) return;
        new Thread(() -> {
            try {
                MoaReleaseControlClient client = new MoaReleaseControlClient(
                        gatewayUrl, gatewayToken, deviceId, new MoaDeviceCredentialStore(app));
                MoaReleaseSelectionPolicy.CatalogPage page =
                        MoaReleaseSelectionPolicy.parseCatalog(client.candidates("", 20));
                MoaReleaseSelectionPolicy.Candidate eligible = null;
                for (MoaReleaseSelectionPolicy.Candidate item : page.candidates) {
                    if (item.compatible) { eligible = item; break; }
                }
                if (eligible == null) return;
                String prior = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .getString(LAST_BUNDLE, "");
                if (eligible.bundleId.equals(prior)) return;
                if (prior.isEmpty()) {
                    app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                            .putString(LAST_BUNDLE, eligible.bundleId).apply();
                    return;
                }
                if (post(app, eligible)) {
                    app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                            .putString(LAST_BUNDLE, eligible.bundleId).apply();
                }
            } catch (Exception ignored) {
                // Discovery is advisory; network and notification failures change no release state.
            }
        }, "moa-release-candidate-notifier").start();
    }

    private static boolean post(Context context, MoaReleaseSelectionPolicy.Candidate candidate) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                    "Ag test candidates", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Announces newly eligible test candidates; selection and installation stay separate.");
            manager.createNotificationChannel(channel);
        }
        Intent intent = new Intent(context, MainActivity.class)
                .putExtra(MainActivity.EXTRA_RELEASE_BUNDLE_ID, candidate.bundleId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(context, NOTIFICATION_ID, intent, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_ID) : new Notification.Builder(context);
        builder.setSmallIcon(R.drawable.ic_moa_orb)
                .setContentTitle(candidate.humanLabel() + " is ready to test")
                .setContentText(candidate.summary() + " Tap to review the exact candidate.")
                .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_STATUS);
        try {
            manager.notify(NOTIFICATION_ID, builder.build());
            return true;
        } catch (SecurityException ignored) {
            return false;
        }
    }

    private static String safe(String value) { return value == null ? "" : value.trim(); }
}
