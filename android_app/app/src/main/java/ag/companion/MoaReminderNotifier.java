package ag.companion;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONObject;

/** Android-owned reminder notification capability and display receipt. */
final class MoaReminderNotifier {
    private static final String CHANNEL_ID = "ag_reminders";

    private MoaReminderNotifier() {
    }

    static boolean capabilityAvailable(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || !manager.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel existing = manager.getNotificationChannel(CHANNEL_ID);
            if (existing != null && existing.getImportance() == NotificationManager.IMPORTANCE_NONE) {
                return false;
            }
        }
        return true;
    }

    static Result post(Context context, MoaReminderNotificationPolicy.Decision reminder) {
        if (reminder == null || !reminder.allowed) return Result.failed("invalid_reminder");
        if (!capabilityAvailable(context)) return Result.failed("notifications_unavailable");
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return Result.failed("notification_manager_unavailable");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Ag reminders",
                    NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Due reminders created inside Ag.");
            manager.createNotificationChannel(channel);
            if (!capabilityAvailable(context)) return Result.failed("reminder_channel_disabled");
        }

        int notificationId = stableNotificationId(reminder.reminderId);
        Intent open = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent openIntent = PendingIntent.getActivity(context, notificationId, open, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_ID) : new Notification.Builder(context);
        builder.setSmallIcon(R.drawable.ic_moa_orb)
                .setContentTitle("Reminder from Ag")
                .setContentText(reminder.message)
                .setStyle(new Notification.BigTextStyle().bigText(reminder.message))
                .setContentIntent(openIntent)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setVisibility(Notification.VISIBILITY_PRIVATE);
        long dueAtMs = DateParser.parse(reminder.dueAt);
        if (dueAtMs > 0L) builder.setWhen(dueAtMs).setShowWhen(true);
        try {
            manager.notify(notificationId, builder.build());
            for (android.service.notification.StatusBarNotification active
                    : manager.getActiveNotifications()) {
                if (active.getId() == notificationId) {
                    return Result.displayed(notificationId);
                }
            }
            return Result.failed("notification_not_active");
        } catch (SecurityException denied) {
            return Result.failed("notification_permission_denied");
        }
    }

    static MoaToolRequestExecution execute(Context context, String gatewayUrl, String gatewayToken,
            String deviceId, String requestId, JSONObject input) {
        String reminderId = clean(input == null ? "" : input.optString("reminder_id", ""));
        try {
            JSONObject payload = new MoaGatewayClient(gatewayUrl, gatewayToken).reminder(reminderId);
            MoaReminderNotificationPolicy.Decision decision = MoaReminderNotificationPolicy.evaluate(
                    requestId, deviceId, input, payload.optJSONObject("reminder"));
            if (!decision.allowed) return execution(context, reminderId, Result.failed(decision.reason));
            return execution(context, reminderId, post(context, decision));
        } catch (Exception error) {
            return execution(context, reminderId, Result.failed("reminder_revalidation_failed"));
        }
    }

    private static MoaToolRequestExecution execution(Context context, String reminderId, Result result) {
        String summary = result.displayed ? "Displayed due Ag reminder."
                : "Reminder notification was not displayed: " + clean(result.status) + ".";
        String target = clean(reminderId);
        if (result.notificationId > 0) target += ":" + result.notificationId;
        JSONObject receipt = MoaActionReceiptStore.record(context, "notification.reminder",
                "local_output", "android_notification_permission", target, result.displayed,
                summary, clean(result.status));
        return new MoaToolRequestExecution(result.displayed, summary, receipt);
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static int stableNotificationId(String reminderId) {
        return 0x40000000 | (reminderId.hashCode() & 0x3fffffff);
    }

    private static final class DateParser {
        static long parse(String value) {
            try {
                return java.time.Instant.parse(value).toEpochMilli();
            } catch (RuntimeException invalid) {
                return 0L;
            }
        }
    }

    static final class Result {
        final boolean displayed;
        final String status;
        final int notificationId;

        private Result(boolean displayed, String status, int notificationId) {
            this.displayed = displayed;
            this.status = status;
            this.notificationId = notificationId;
        }

        static Result displayed(int id) {
            return new Result(true, "notification_active", id);
        }

        static Result failed(String status) {
            return new Result(false, status, 0);
        }
    }
}
