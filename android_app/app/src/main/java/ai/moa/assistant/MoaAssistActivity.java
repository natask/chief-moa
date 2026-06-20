package ai.moa.assistant;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;

public final class MoaAssistActivity extends Activity {
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
        if (!Settings.canDrawOverlays(this) || !hasMicrophonePermission()) {
            Intent setup = new Intent(this, MainActivity.class);
            setup.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            setup.putExtra(MainActivity.EXTRA_START_OVERLAY, true);
            startActivity(setup);
            finish();
            return;
        }

        Intent service = new Intent(this, OverlayService.class);
        service.setAction(OverlayService.ACTION_ASSIST_BUTTON);
        service.putExtra(OverlayService.EXTRA_START_VOICE, true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(service);
        } else {
            startService(service);
        }
        finish();
        overridePendingTransition(0, 0);
    }

    private boolean hasMicrophonePermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }
}
