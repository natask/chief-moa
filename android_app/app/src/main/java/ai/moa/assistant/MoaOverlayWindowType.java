package ai.moa.assistant;

import android.os.Build;
import android.view.WindowManager;

final class MoaOverlayWindowType {
    private MoaOverlayWindowType() {
    }

    static int resolve() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
        }
        return WindowManager.LayoutParams.TYPE_PHONE;
    }
}
