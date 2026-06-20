package ai.moa.assistant;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

public final class MoaQuickTileService extends TileService {
    @Override
    public void onStartListening() {
        super.onStartListening();
        updateTile();
    }

    @Override
    public void onClick() {
        super.onClick();
        if (!Settings.canDrawOverlays(this)) {
            openMainActivity();
            return;
        }

        boolean shouldRun = !OverlayService.isRunning();
        Intent intent = new Intent(this, OverlayService.class);
        try {
            if (shouldRun && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent);
            } else if (shouldRun) {
                startService(intent);
            } else {
                stopService(intent);
            }
        } catch (RuntimeException error) {
            openMainActivity();
            return;
        }
        updateTile(shouldRun);
    }

    private void updateTile() {
        updateTile(OverlayService.isRunning());
    }

    private void updateTile(boolean active) {
        Tile tile = getQsTile();
        if (tile == null) {
            return;
        }

        tile.setLabel("Moa");
        tile.setState(active ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        tile.updateTile();
    }

    @SuppressWarnings("deprecation")
    private void openMainActivity() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent, flags);
            startActivityAndCollapse(pendingIntent);
        } else {
            startActivityAndCollapse(intent);
        }
    }
}
