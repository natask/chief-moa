package ai.moa.assistant;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

final class MoaAssistantLaunchCoordinator {
    static final String ACTION_VOICE_ASSIST = "android.intent.action.VOICE_ASSIST";
    static final String ACTION_VOICE_COMMAND = "android.intent.action.VOICE_COMMAND";
    static final String EXTRA_SOURCE = "ai.moa.assistant.extra.INVOCATION_SOURCE";
    static final String SOURCE_NOTIFICATION = "overlay_notification";
    static final String SOURCE_QUICK_TILE = "quick_tile";

    private MoaAssistantLaunchCoordinator() {
    }

    static Intent assistActivityIntent(Context context, String source) {
        return new Intent(context, MoaAssistActivity.class)
                .setAction(Intent.ACTION_ASSIST)
                .putExtra(EXTRA_SOURCE, source == null ? "unknown" : source);
    }

    static void startVoiceService(Context context, String source) {
        Intent service = new Intent(context, OverlayService.class)
                .setAction(OverlayService.ACTION_ASSIST_BUTTON)
                .putExtra(OverlayService.EXTRA_START_VOICE, true)
                .putExtra(EXTRA_SOURCE, source == null ? "unknown" : source);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(service);
        } else {
            context.startService(service);
        }
    }

    static boolean isAssistAction(String action) {
        return Intent.ACTION_ASSIST.equals(action)
                || ACTION_VOICE_ASSIST.equals(action)
                || ACTION_VOICE_COMMAND.equals(action);
    }
}
