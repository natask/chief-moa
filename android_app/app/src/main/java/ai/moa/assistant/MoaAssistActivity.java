package ai.moa.assistant;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;

public final class MoaAssistActivity extends Activity {
    private static final String TAG = "MoaAssistLaunch";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleAssistLaunch();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleAssistLaunch();
    }

    private void handleAssistLaunch() {
        boolean overlayPermissionGranted = Settings.canDrawOverlays(this);
        boolean microphonePermissionGranted = hasMicrophonePermission();
        MoaAssistLaunchDecision.Action action = MoaAssistLaunchDecision.decide(overlayPermissionGranted, microphonePermissionGranted);
        Log.i(TAG, "handleAssistLaunch action=" + action
                + " overlay=" + overlayPermissionGranted
                + " microphone=" + microphonePermissionGranted);
        if (action == MoaAssistLaunchDecision.Action.SHOW_PERMISSION_HINT) {
            Toast.makeText(
                    getApplicationContext(),
                    MoaAssistLaunchDecision.permissionHint(overlayPermissionGranted, microphonePermissionGranted),
                    Toast.LENGTH_SHORT
            ).show();
            finishAndSuppressAnimation();
            return;
        }

        startVoiceService();
        finishAndSuppressAnimation();
    }

    private void startVoiceService() {
        Intent service = new Intent(this, OverlayService.class);
        service.setAction(OverlayService.ACTION_ASSIST_BUTTON);
        service.putExtra(OverlayService.EXTRA_START_VOICE, true);
        Log.i(TAG, "startVoiceService action=" + service.getAction());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(service);
        } else {
            startService(service);
        }
    }

    private void finishAndSuppressAnimation() {
        finish();
        overridePendingTransition(0, 0);
    }

    private boolean hasMicrophonePermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }
}
