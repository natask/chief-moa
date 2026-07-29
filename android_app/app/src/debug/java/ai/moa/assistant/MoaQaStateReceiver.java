package ai.moa.assistant;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Debug-APK-only bridge for deterministic, offline UI Automator fixtures. */
public final class MoaQaStateReceiver extends BroadcastReceiver {
    public static final String ACTION = "ai.moa.assistant.debug.QA_STATE";

    @Override
    public void onReceive(Context context, Intent input) {
        if (!BuildConfig.DEBUG || input == null || !ACTION.equals(input.getAction())) {
            return;
        }
        Intent service = new Intent(context, OverlayService.class)
                .setAction(OverlayService.ACTION_QA_STATE)
                .putExtra(OverlayService.EXTRA_QA_STATE, input.getStringExtra("state"))
                .putExtra(OverlayService.EXTRA_QA_TEXT, input.getStringExtra("text"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(service);
        } else {
            context.startService(service);
        }
    }
}
