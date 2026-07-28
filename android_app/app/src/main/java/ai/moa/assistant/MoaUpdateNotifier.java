package ai.moa.assistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.os.Build;

import org.json.JSONObject;

/** Best-effort availability notification. It never downloads an APK. */
final class MoaUpdateNotifier {
    private static final String CHANNEL_ID = "moa_app_updates";
    private static final int NOTIFICATION_ID = 5702;

    private MoaUpdateNotifier() {
    }

    static void checkAsync(Context context, String gatewayUrl, String gatewayToken) {
        Context appContext = context.getApplicationContext();
        String url = safe(gatewayUrl);
        if (url.isEmpty()) {
            return;
        }
        new Thread(() -> {
            try {
                JSONObject manifest = new MoaGatewayClient(url, safe(gatewayToken)).latestAndroidUpdate();
                MoaUpdatePolicy.Decision decision = MoaUpdatePolicy.evaluate(
                        manifest,
                        currentVersionCode(appContext),
                        BuildConfig.GIT_SHA,
                        MoaPrefs.deferredUpdateVersionCode(appContext)
                );
                if (decision.state != MoaUpdatePolicy.State.AVAILABLE
                        || decision.versionCode == MoaPrefs.notifiedUpdateVersionCode(appContext)) {
                    return;
                }
                if (postNotification(appContext, decision)) {
                    MoaPrefs.markUpdateNotified(appContext, decision.versionCode);
                }
            } catch (Exception ignored) {
                // Offline, denied notification permission, or invalid metadata:
                // leave the installed app and user preferences untouched.
            }
        }, "moa-update-notifier").start();
    }

    private static boolean postNotification(Context context, MoaUpdatePolicy.Decision decision) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "AG app updates",
                    NotificationManager.IMPORTANCE_DEFAULT
            );
            channel.setDescription("Announces available AG versions. Updates are never installed automatically.");
            manager.createNotificationChannel(channel);
        }

        Intent review = new Intent(context, MainActivity.class)
                .putExtra(MainActivity.EXTRA_REVIEW_UPDATE, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent reviewIntent = PendingIntent.getActivity(context, NOTIFICATION_ID, review, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_ID)
                : new Notification.Builder(context);
        builder.setSmallIcon(R.drawable.ic_moa_orb)
                .setContentTitle("A new AG version is available")
                .setContentText("Version " + decision.versionName + " — tap to review. Nothing installs automatically.")
                .setStyle(new Notification.BigTextStyle().bigText(
                        "Version " + decision.versionName
                                + " is available. Tap to review it or keep your current version. "
                                + "Nothing downloads or installs automatically."
                ))
                .setContentIntent(reviewIntent)
                .addAction(new Notification.Action.Builder(
                        null,
                        "Review update",
                        reviewIntent
                ).build())
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_STATUS);
        try {
            manager.notify(NOTIFICATION_ID, builder.build());
            return true;
        } catch (SecurityException ignored) {
            return false;
        }
    }

    private static long currentVersionCode(Context context) throws Exception {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : info.versionCode;
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}
