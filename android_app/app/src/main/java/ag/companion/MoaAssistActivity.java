package ag.companion;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
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
        MoaInvocationResolver.Invocation invocation =
                MoaInvocationResolver.resolve(getIntent().getAction());
        if (invocation == MoaInvocationResolver.Invocation.CONTROL_CENTER) {
            Log.i(TAG, "handleAssistLaunch invocation=" + invocation);
            startActivity(new Intent(this, MainActivity.class));
            finishAndSuppressAnimation();
            return;
        }
        boolean overlayPermissionGranted = Settings.canDrawOverlays(this);
        boolean microphonePermissionGranted = hasMicrophonePermission();
        MoaAssistLaunchDecision.Action action = MoaAssistLaunchDecision.decide(overlayPermissionGranted, microphonePermissionGranted);
        Log.i(TAG, "handleAssistLaunch action=" + action
                + " invocation=" + invocation
                + " intent=" + getIntent().getAction()
                + " source=" + getIntent().getStringExtra(MoaAssistantLaunchCoordinator.EXTRA_SOURCE)
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

        startVoiceService(invocation);
        finishAndSuppressAnimation();
    }

    private void startVoiceService(MoaInvocationResolver.Invocation invocation) {
        String source = getIntent().getStringExtra(MoaAssistantLaunchCoordinator.EXTRA_SOURCE);
        if (source == null || source.trim().isEmpty()) {
            source = getIntent().getAction();
        }
        Log.i(TAG, "startVoiceService source=" + source);
        MoaAssistantLaunchCoordinator.startVoiceService(
                this,
                source,
                invocation);
    }

    private void finishAndSuppressAnimation() {
        finish();
        overridePendingTransition(0, 0);
    }

    private boolean hasMicrophonePermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }
}
