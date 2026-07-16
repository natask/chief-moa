package ai.moa.assistant;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.text.TextUtils;

import java.util.Collections;
import java.util.List;

/**
 * User-granted bridge to Android's active media sessions.
 *
 * <p>This service deliberately does not inspect or retain notifications. Its
 * only production API is the platform MediaSession list authorized by the
 * Notification access grant.</p>
 */
public final class MoaMediaNotificationListenerService extends NotificationListenerService {
    private static final String ENABLED_NOTIFICATION_LISTENERS = "enabled_notification_listeners";

    static boolean isAccessEnabled(Context context) {
        if (context == null) {
            return false;
        }
        String enabled = Settings.Secure.getString(
                context.getContentResolver(),
                ENABLED_NOTIFICATION_LISTENERS
        );
        if (TextUtils.isEmpty(enabled)) {
            return false;
        }

        ComponentName expected = new ComponentName(context, MoaMediaNotificationListenerService.class);
        TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
        splitter.setString(enabled);
        while (splitter.hasNext()) {
            ComponentName candidate = ComponentName.unflattenFromString(splitter.next());
            if (expected.equals(candidate)) {
                return true;
            }
        }
        return false;
    }

    static Intent accessSettingsIntent() {
        return new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
    }

    static List<MediaController> activeControllers(Context context) {
        if (!isAccessEnabled(context)) {
            return Collections.emptyList();
        }
        MediaSessionManager manager = context.getSystemService(MediaSessionManager.class);
        if (manager == null) {
            return Collections.emptyList();
        }
        try {
            List<MediaController> controllers = manager.getActiveSessions(
                    new ComponentName(context, MoaMediaNotificationListenerService.class)
            );
            return controllers == null ? Collections.emptyList() : controllers;
        } catch (SecurityException ignored) {
            // The secure setting and system authorization can race during grant
            // or revocation. Treat the session list as unavailable.
            return Collections.emptyList();
        }
    }
}
