package ag.companion;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
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
        openAssistant();
        updateTile(true);
    }

    private void updateTile() {
        updateTile(OverlayService.isRunning());
    }

    private void updateTile(boolean active) {
        Tile tile = getQsTile();
        if (tile == null) {
            return;
        }

        tile.setLabel("Ag");
        tile.setState(active ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        tile.updateTile();
    }

    private void openAssistant() {
        Intent intent = MoaAssistantLaunchCoordinator.assistActivityIntent(
                this, MoaAssistantLaunchCoordinator.SOURCE_QUICK_TILE);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent, flags);
            startActivityAndCollapse(pendingIntent);
        } else {
            startLegacyActivityAndCollapse(intent);
        }
    }

    @SuppressWarnings("deprecation")
    @SuppressLint("StartActivityAndCollapseDeprecated")
    private void startLegacyActivityAndCollapse(Intent intent) {
        startActivityAndCollapse(intent);
    }
}
